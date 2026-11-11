import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import path from "node:path";
import { z } from "zod";
import {
  pool,
  seedInitialTechnicians,
  query,
  transaction,
} from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createWebSocketServer } from "./realtime/websocketServer.js";
import {
  canAccessConversation,
  canCommunicateOnRequest,
} from "./privacy/communicationAuth.js";
import authRoutes from "./auth/routes.js";
import { requireAuth, requireRole } from "./auth/authMiddleware.js";
import { NotificationService } from "./notifications/notificationService.js";
import type { RecordEventNotificationParams } from "./notifications/notificationService.js";
import {
  assertOfferCreateAccess,
  assertOfferEligibility,
  assertTechnicianOfferCollection,
  loadOfferForResponse,
  loadRequestForUser,
} from "./auth/authorization.js";
import {
  acceptedTechnicianId,
  assignOfferAtomically,
  createOfferForCandidate,
  findNextCandidate,
  offerTimeoutMinutes,
  processOfferOutcome,
  recordRequestEvent,
  releaseTechnicianCapacity,
  retryDispatchForRequest,
  sweepExpiredOffers,
  sweepIntervalMs,
  sweepStuckMatchingRequests,
  sweepWaitingRequests,
  waitingRetryMinutes,
} from "./dispatch/dispatchService.js";
import { loadJwtConfig, registerJwt } from "./auth/jwt.js";
import { assertUuid, CITY_CENTRES } from "./auth/authService.js";
import { seedAdminFromEnv } from "./auth/seedAdmin.js";
import { getFileStorage } from "./storage/fileStorage.js";
import { validateMagicBytes } from "./storage/fileValidation.js";
import {
  recordAuditEvent,
  listAuditEvents,
  AUDIT_EVENT_TYPES,
} from "./privacy/auditService.js";
import type { AuditOutcome } from "./privacy/auditService.js";
import {
  buildAccountExport,
  permanentlyDeleteAccount,
  previewAccountDeletion,
} from "./privacy/accountDataService.js";
import { verifyPassword } from "./auth/password.js";
import {
  ClassificationError,
  classifyFaultDescription,
} from "./ai/faultClassifier.js";
import {
  CANONICAL_CATEGORIES,
  type AdminActivityEventApi,
  type AdminOverviewApi,
  type AdminRequestApi,
  type AdminTechnicianApi,
  type AdminTechnicianVerificationApi,
  type AdminUserApi,
  type DispatchOfferStatus,
  type OfferApi,
  type PushSubscriptionApi,
  type RequestReviewApi,
  type ReviewApi,
  type ServiceRequestApi,
  type ServiceRequestStatus,
  type TechnicianApi,
  type TechnicianDocumentApi,
  type TechnicianOwnProfileApi,
  type TechnicianReviewsApi,
  type TechnicianVerificationStatus,
  type UserRole,
  type VerificationDocumentStatus,
  type VerificationDocumentType,
  type VerificationReviewApi,
} from "./types/api.js";
import crypto from "crypto";
import type { PoolClient } from "pg";

const isProduction = process.env.NODE_ENV === "production";

// Hosted API platforms normally terminate TLS before forwarding a request to
// Node. Trust the forwarding headers only when explicitly enabled by the
// deployment configuration; local development retains the safer default.
const app: FastifyInstance = Fastify({
  logger: true,
  trustProxy: process.env.TRUST_PROXY === "true",
});

// Central error handler — registered BEFORE any plugin boot or route
// registration: Fastify snapshots the active error handler into each route
// context at registration time (lib/route.js) and inherits it when an
// encapsulated plugin boots, so a handler installed later would silently
// never run. 4xx answers always carry { error } (plus validation
// details when present); 5xx answers are generic.
app.setErrorHandler((error, _, reply) => {
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  const message =
    error instanceof Error ? error.message : "Internal server error";
  // 5xx → log at error level with the stack; 4xx (validation/auth) → warn
  // without bodies, so credentials/tokens can never reach the logs.
  if (statusCode >= 500) {
    app.log.error(error);
  } else {
    app.log.warn({ statusCode, message }, "request rejected");
  }
  const details =
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    error.details !== undefined
      ? (error as { details?: unknown }).details
      : undefined;
  reply.status(statusCode).send({
    error: statusCode < 500 ? message : "Internal server error",
    ...(details !== undefined ? { details } : {}),
  });
});

// Task 28 §14 — CORS uses an EXPLICIT allow-list, never '*'. FRONTEND_ORIGIN
// accepts a comma-separated list for production (multiple deployed origins);
// a single value behaves exactly as before. Credentials stay enabled so the
// HttpOnly refresh cookie rides along from an allowed origin.
const configuredFrontendOrigin = process.env.FRONTEND_ORIGIN;
if (isProduction && !configuredFrontendOrigin) {
  throw new Error(
    "FRONTEND_ORIGIN must be set to the deployed frontend origin in production.",
  );
}
const corsOrigins = (configuredFrontendOrigin ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

await app.register(cors, {
  origin: corsOrigins.length <= 1 ? (corsOrigins[0] ?? false) : corsOrigins,
  // Credentialed CORS: the origin is an explicit allow-list entry (never
  // '*'), and credentials:true lets the HttpOnly refresh cookie ride along
  // with /auth/refresh requests from the frontend origin.
  credentials: true,
  // Explicit allow-list: the frontend uses GET (reads), POST (creates and
  // explicit prototype outcomes), PATCH (request status transitions), PUT
  // (Task 28.4B: replacing the account's own contact number at
  // /api/v1/me/phone), and DELETE (Task 26: withdrawing a verification
  // document before review). Anything else stays blocked by the preflight.
  //
  // PUT must stay in this list: browser preflights rejected the phone-number
  // save while the endpoint itself was working, so the form failed in the app
  // and succeeded from curl/tests — the classic CORS-only failure mode.
  methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// HttpOnly refresh-token cookie support (parse request.cookies + reply.setCookie).
await app.register(cookie);

// Multipart uploads (Task 26): profile photos + verification documents.
// One file per request, hard 5 MB ceiling — oversized uploads are rejected
// by the parser (413) before any byte reaches storage.
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// Task 28 §13 — root-scope rate limiting, OPT-IN per route (global:false) so
// bulk public reads and the automated regression suites are never throttled.
// The auth endpoints keep their own stricter limiter inside authRoutes.ts.
// Per-route limits below are env-configurable; defaults are generous enough
// for legitimate traffic and the existing test suites.
await app.register(rateLimit, { global: false });

function routeRateLimit(envKey: string, fallbackMax: number) {
  const configured = Number(process.env[envKey]);
  const max =
    Number.isFinite(configured) && configured > 0 ? configured : fallbackMax;
  return { max, timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute" };
}

// Task 28 §15 — production security headers on every API response. This is a
// JSON-only API (no HTML or inline assets are served), so a locked-down CSP is
// safe and cannot break the separate Next.js frontend origin. Registered
// before any route so the hook is snapshotted into every route context.
app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  reply.header(
    "permissions-policy",
    "geolocation=(), microphone=(), camera=(), payment=()",
  );
  reply.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  return payload;
});

// JWT access tokens — secret/issuer/audience/TTL come from the environment;
// startup FAILS FAST when JWT_SECRET is missing or too short (no default).
await registerJwt(app, loadJwtConfig());

// Initialize schema (deterministic migrations) and seed data BEFORE any
// traffic is served — startup is atomic: no route ever answers against a
// half-migrated database.
try {
  await runMigrations();
  // Demo identities, ratings and locations must never be created merely
  // because a real production database happens to be empty. Opt in only for
  // local/demo environments.
  if (process.env.SEED_DEMO_DATA === "true") {
    await seedInitialTechnicians();
  }
  await seedAdminFromEnv();
  console.log("Database migrated and seeded");
} catch (err) {
  console.error("Failed to initialize database:", err);
  process.exit(1);
}

// Validate the file-storage provider BEFORE serving traffic: a bad
// STORAGE_PROVIDER or incomplete Supabase config must fail the deploy with
// a precise message instead of surfacing as 500s on the first upload or
// photo read.
try {
  getFileStorage();
  console.log(
    `File storage provider: ${(process.env.STORAGE_PROVIDER ?? "local").trim().toLowerCase()}`,
  );
} catch (err) {
  console.error("Failed to initialize file storage:", err);
  process.exit(1);
}

// Auth API under /api/v1/auth (register/login/refresh/logout/me).
await app.register(authRoutes, { prefix: "/api/v1/auth" });

// Canonical categories (9, single source: types/api.ts — mirrors frontend lib/categories.ts)
const categories = CANONICAL_CATEGORIES;

type Category = (typeof categories)[number];

/** Statuses the API accepts and persists — mirrors the frontend lifecycle contract. */
const SERVICE_REQUEST_STATUSES: readonly ServiceRequestStatus[] = [
  "pending",
  "matching",
  "matched",
  "no_match",
  "in_progress",
  "completed",
  "cancelled",
];
const OFFER_STATUSES: readonly DispatchOfferStatus[] = [
  "pending",
  "accepted",
  "rejected",
  "timed_out",
];

/**
 * Validate a status string read from the database before it enters
 * a typed API response. Throws (→ 500, safe message) on unknown values
 * instead of leaking an invalid state to clients.
 */
function toRequestStatus(value: string): ServiceRequestStatus {
  if ((SERVICE_REQUEST_STATUSES as readonly string[]).includes(value)) {
    return value as ServiceRequestStatus;
  }
  throw new Error("Invalid service request status in database record");
}

function toOfferStatus(value: string): DispatchOfferStatus {
  if ((OFFER_STATUSES as readonly string[]).includes(value)) {
    return value as DispatchOfferStatus;
  }
  throw new Error("Invalid offer status in database record");
}

// Zod validation for service request creation
const requestSchema = z.object({
  description: z.string().min(8).max(2000),
  category: z.enum(categories as unknown as [string, ...string[]]),
  city: z.enum(["Kitwe", "Ndola", "Other"]),
  /**
   * Task 36 (Stage 5, finding #10): browser-generated idempotency key. The
   * SAME key submitted twice by the SAME customer returns the SAME request
   * instead of creating a duplicate (double-tap / network retry). Absent on
   * legacy calls, which keep working exactly as before.
   */
  clientRequestId: z.string().uuid().optional(),
});

/**
 * Helper to return JSON API responses. `meta` carries non-data context
 * (Task 36: dispatch outcomes, idempotent-replay flags) — additive and
 * optional, so existing callers are unaffected.
 */
function jsonResponse<T>(
  reply: FastifyReply,
  status: number,
  payload: { data?: T; error?: string; message?: string; details?: unknown; meta?: unknown },
) {
  return reply.status(status).send(payload);
}

/**
 * GET /api/v1/technicians
 * Returns all technicians (camelCase keys).
 *
 * Task 28.3A.1 (G-01) — PUBLIC COORDINATES ARE NEVER RETURNED. The stored
 * `latitude`/`longitude`/`location` exist only so the dispatch engine can do
 * PostGIS distance work server-side (see assertOfferEligibility and
 * GET /technicians/nearby). Public callers get coarse, self-declared service
 * information instead: `serviceArea` (and the city derived from it). Adding a
 * coordinate field back to this projection would be a privacy regression.
 */
app.get("/api/v1/technicians", async (_, reply) => {
  try {
    const rows = await query<{
      id: string;
      name: string;
      category: string;
      skills: string[];
      service_area: string;
      rating: number;
      jobs: number;
      verified: boolean;
      availability: string;
      availability_status: string;
      account_status: string;
      bio: string | null;
      has_photo: boolean;
      created_at: string;
      updated_at: string;
    }>(`
      SELECT id, name, category, skills, service_area, rating, jobs, verified,
             availability, availability_status, account_status,
             bio, (photo_key IS NOT NULL) AS has_photo,
             created_at, updated_at
      FROM technicians
      ORDER BY name
    `);
    const technicians: TechnicianApi[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      skills: r.skills,
      serviceArea: r.service_area,
      rating: r.rating,
      jobs: r.jobs,
      verified: r.verified,
      availability: r.availability,
      availabilityStatus: r.availability_status,
      accountStatus: r.account_status,
      bio: r.bio,
      hasPhoto: r.has_photo,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return jsonResponse(reply, 200, { data: technicians });
  } catch (error) {
    app.log.error(error);
    return jsonResponse(reply, 500, { error: "Failed to fetch technicians" });
  }
});

/**
 * GET /api/v1/technicians/:id
 *
 * Task 28.3A.1 (G-01) — same boundary as the list route: unauthenticated
 * callers never receive a stored coordinate. Coarse location is conveyed by
 * `serviceArea` alone.
 */
app.get("/api/v1/technicians/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const rows = await query<{
      id: string;
      name: string;
      category: string;
      skills: string[];
      service_area: string;
      rating: number;
      jobs: number;
      verified: boolean;
      availability: string;
      availability_status: string;
      account_status: string;
      bio: string | null;
      has_photo: boolean;
      created_at: string;
      updated_at: string;
    }>(
      "SELECT id, name, category, skills, service_area, rating, jobs, verified, availability, availability_status, account_status, bio, (photo_key IS NOT NULL) AS has_photo, created_at, updated_at FROM technicians WHERE id = $1",
      [id],
    );
    if (rows.length === 0) {
      return jsonResponse(reply, 404, { error: "Technician not found" });
    }
    // Audit §5.D — customer-facing trust indicators. Only document CATEGORIES
    // an authorised reviewer has individually APPROVED are exposed (distinct
    // category names — no images, identity numbers, filenames, keys or notes).
    const catRows = await query<{ document_type: string }>(
      `SELECT DISTINCT document_type
       FROM technician_verification_documents
       WHERE technician_id = $1 AND status = 'approved'`,
      [id],
    );
    const verifiedCategories = catRows.map(
      (c) => c.document_type as VerificationDocumentType,
    );
    const tech: TechnicianApi = {
      id: rows[0].id,
      name: rows[0].name,
      category: rows[0].category,
      skills: rows[0].skills,
      serviceArea: rows[0].service_area,
      rating: rows[0].rating,
      jobs: rows[0].jobs,
      verified: rows[0].verified,
      availability: rows[0].availability,
      availabilityStatus: rows[0].availability_status,
      accountStatus: rows[0].account_status,
      bio: rows[0].bio,
      hasPhoto: rows[0].has_photo,
      verifiedCategories,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
    };
    return jsonResponse(reply, 200, { data: tech });
  } catch (error) {
    app.log.error(error);
    return jsonResponse(reply, 500, { error: "Failed to fetch technician" });
  }
});

/**
 * GET /api/v1/technicians/nearby
 *
 * Task 28.3A.1 (G-01) — PostGIS RADIUS SEARCH IS PRESERVED, PRECISE
 * COORDINATES ARE NOT DISCLOSED.
 *
 *   - The caller supplies their OWN latitude/longitude as a query parameter.
 *     Echoing a caller's own input back to them is not a disclosure, and the
 *     radius search cannot work without it.
 *   - The stored technician `location` point is used ONLY inside the SQL
 *     predicate and ORDER BY. It is never projected into the response.
 *   - `distance_meters` is coarsened to 100 m before it leaves the server.
 *     Exact metres would let a caller triangulate a technician's position by
 *     repeatedly probing from different points; 100 m buckets raise the cost
 *     of that substantially without making the feature useless.
 *   - Residual inference risk is NOT eliminated by rounding alone, so this
 *     route is now rate limited (it previously had none) to bound probe volume.
 *
 * Documented decision: approximate distance is a legitimate coarse signal for
 * "who is near me", and is retained in coarsened form. Precise coordinates are
 * not, and are gone.
 */
app.get(
  "/api/v1/technicians/nearby",
  { config: { rateLimit: routeRateLimit("RATE_LIMIT_TECHNICIAN_SEARCH", 30) } },
  async (request, reply) => {
    const queryParams = request.query as Record<string, unknown>;
    const latitude = Number(queryParams.latitude);
    const longitude = Number(queryParams.longitude);
    const radiusKm =
      queryParams.radius === undefined ? 50 : Number(queryParams.radius);
    const category =
      typeof queryParams.category === "string"
        ? queryParams.category
        : undefined;

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return jsonResponse(reply, 400, {
        error: "Valid latitude (-90 to 90) is required",
      });
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return jsonResponse(reply, 400, {
        error: "Valid longitude (-180 to 180) is required",
      });
    }
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 100) {
      return jsonResponse(reply, 400, {
        error: "Radius must be a positive number of kilometres (max 100)",
      });
    }
    if (category !== undefined && !categories.includes(category as Category)) {
      return jsonResponse(reply, 400, {
        error: `Invalid category: ${category}`,
      });
    }

    const radiusMeters = radiusKm * 1000;

    try {
      // Build SQL dynamically. `location` appears only in the predicate and the
      // ordering — never in the projection.
      let sql = `
      SELECT id, name, category, skills, service_area, rating, jobs, verified,
             availability, availability_status, account_status,
             created_at, updated_at,
             ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
      FROM technicians
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
    `;
      const params: any[] = [latitude, longitude, radiusMeters];

      if (category && categories.includes(category as Category)) {
        sql += " AND category = $4";
        params.push(category);
      }

      sql += " ORDER BY distance_meters ASC";

      const rows = await query<{
        id: string;
        name: string;
        category: string;
        skills: string[];
        service_area: string;
        rating: number;
        jobs: number;
        verified: boolean;
        availability: string;
        availability_status: string;
        account_status: string;
        created_at: string;
        updated_at: string;
        distance_meters: number;
      }>(sql, params);

      const technicians: (TechnicianApi & { distance_meters: number })[] =
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          category: r.category,
          skills: r.skills,
          serviceArea: r.service_area,
          rating: r.rating,
          jobs: r.jobs,
          verified: r.verified,
          availability: r.availability,
          availabilityStatus: r.availability_status,
          accountStatus: r.account_status,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          // Coarsened to a 100 m bucket — see the route comment above.
          distance_meters: Math.round(r.distance_meters / 100) * 100,
        }));

      return jsonResponse(reply, 200, { data: technicians });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to find nearby technicians",
      });
    }
  },
);

/**
 * POST /api/v1/requests (create a service request)
 * Customer-only. The owner column is derived from the ACCESS TOKEN — the
 * client cannot name a customerUserId (any such field is stripped by the
 * schema and ignored).
 */
app.post(
  "/api/v1/requests",
  { preHandler: requireRole("customer") },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }

    const { description, category, city } = parsed.data;
    const clientRequestId = parsed.data.clientRequestId ?? null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      // Task 36 (Stage 5) — idempotent replay: the same idempotency key from
      // the same customer returns the original request instead of creating a
      // duplicate. The partial unique index in migration 012 is the backstop
      // if two retries race past this read.
      if (clientRequestId) {
        const replay = await query<{
          id: string;
          description: string;
          category: string;
          city: string;
          status: string;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, description, category, city, status, created_at, updated_at
             FROM service_requests
            WHERE customer_user_id = $1 AND client_request_id = $2
            LIMIT 1`,
          [authUser.id, clientRequestId],
        );
        if (replay[0]) {
          return jsonResponse(reply, 200, {
            data: {
              id: replay[0].id,
              description: replay[0].description,
              category: replay[0].category,
              city: replay[0].city,
              status: toRequestStatus(replay[0].status),
              createdAt: replay[0].created_at,
              updatedAt: replay[0].updated_at,
            },
            meta: { idempotentReplay: true },
          });
        }
      }

      // Dispatch selection belongs on the server. A browser must never be
      // able to select its own preferred technician or submit a fabricated
      // ranking. The shared dispatch engine picks the least-loaded eligible
      // candidate; reject/timeout cascade continues from the offer endpoints.
      const created = await transaction(async (client: PoolClient) => {
        const result = await client.query<{
          id: string;
          description: string;
          category: string;
          city: string;
          status: string;
          created_at: string;
          updated_at: string;
        }>(
          `INSERT INTO service_requests
             (id, description, category, city, status, customer_user_id,
              client_request_id, last_dispatch_at, dispatch_attempts, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, NOW(), 1, $7, $8)
           RETURNING id, description, category, city, status, created_at, updated_at`,
          [id, description, category, city, authUser.id, clientRequestId, now, now],
        );

        const request = {
          id,
          category,
          city,
          status: "pending" as string,
          customerUserId: authUser.id as string | null,
        };
        const candidate = await findNextCandidate(client, request);

        if (candidate) {
          await createOfferForCandidate(client, id, candidate);
          await client.query(
            `UPDATE service_requests SET status = 'matching', updated_at = NOW() WHERE id = $1`,
            [id],
          );
          await recordRequestEvent(client, {
            requestId: id,
            fromStatus: "pending",
            toStatus: "matching",
            actorUserId: authUser.id,
            actorRole: authUser.role,
            reason: "initial_dispatch",
          });
          result.rows[0].status = "matching";
        } else {
          // Task 36 (Stage 4, finding #6): "no technician anywhere" is a
          // REAL state, not a silent pending limbo. The request persists as
          // no_match with a diagnosable reason, an audit row, and the
          // customer-visible retry path. The three counts distinguish the
          // directive's four operational situations:
          //   no technician registered for the category at all,
          //   registered but none in this service area,
          //   in the area but none currently available.
          const counts = await client.query<{
            registered: number;
            in_area: number;
            available: number;
          }>(
            `SELECT
               (SELECT COUNT(*)::int FROM technicians
                 WHERE category = $1
                   AND account_status = 'active'
                   AND (verification_status = 'verified' OR verified = true)
               ) AS registered,
               (SELECT COUNT(*)::int FROM technicians
                 WHERE category = $1
                   AND service_area = $2
                   AND account_status = 'active'
                   AND (verification_status = 'verified' OR verified = true)
               ) AS in_area,
               (SELECT COUNT(*)::int FROM technicians
                 WHERE category = $1
                   AND service_area = $2
                   AND account_status = 'active'
                   AND (verification_status = 'verified' OR verified = true)
                   AND availability_status = 'available'
               ) AS available`,
            [category, city],
          );
          const c = counts.rows[0] ?? { registered: 0, in_area: 0, available: 0 };
          const reason =
            c.registered === 0
              ? "no_registered_technician"
              : c.in_area === 0
                ? "no_technician_in_area"
                : c.available === 0
                  ? "none_currently_available"
                  : "none_below_workload_cap";
          await client.query(
            `UPDATE service_requests SET status = 'no_match', updated_at = NOW() WHERE id = $1`,
            [id],
          );
          await recordRequestEvent(client, {
            requestId: id,
            fromStatus: "pending",
            toStatus: "no_match",
            actorUserId: authUser.id,
            actorRole: authUser.role,
            reason,
          });
          result.rows[0].status = "no_match";
          return {
            row: result.rows[0],
            technicianUserId: null as string | null,
            dispatchReason: reason,
          };
        }
        return {
          row: result.rows[0],
          technicianUserId: candidate.technicianUserId,
          dispatchReason: null as string | null,
        };
      });

      const serviceRequest: ServiceRequestApi = {
        id: created.row.id,
        description: created.row.description,
        category: created.row.category,
        city: created.row.city,
        status: toRequestStatus(created.row.status),
        createdAt: created.row.created_at,
        updatedAt: created.row.updated_at,
      };
      if (created.technicianUserId) {
        await recordAndDeliverEvent(
          {
            userId: created.technicianUserId,
            type: "dispatch_offer_created",
            title: "New service offer",
            message: `You have a new ${category} service offer in ${city}.`,
            referenceType: "service_request",
            referenceId: id,
            channel: "in_app",
          },
          (error) => app.log.error(error),
        );
      }
      return jsonResponse(reply, 201, {
        data: serviceRequest,
        ...(created.dispatchReason
          ? { meta: { dispatch: { reason: created.dispatchReason } } }
          : {}),
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to create service request",
      });
    }
  },
);

/**
 * POST /api/v1/classify-fault — AI-assisted fault classification (Task 33).
 *
 * Customer-only. Sends ONLY the trimmed fault description to Gemini (no
 * names, accounts, or technician data) and returns the validated category
 * plus a display summary. The category is re-validated against the canonical
 * vocabulary here as well as in the classifier, so a model hallucination
 * can never enter the request flow.
 *
 * Every failure is user-safe and keeps manual selection working: the
 * frontend treats any non-200 as "suggest unavailable, choose manually".
 * Provider detail (status codes, key state, quota) is logged server-side
 * WITHOUT the description or key, and never reaches the response.
 */
app.post(
  "/api/v1/classify-fault",
  {
    preHandler: requireRole("customer"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_CLASSIFY", 20) },
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z
      .object({ description: z.string().min(8).max(2000) })
      .safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    try {
      const result = await classifyFaultDescription(parsed.data.description);
      if (!(categories as readonly string[]).includes(result.category)) {
        app.log.warn({ msg: "Classifier returned off-vocabulary category" });
        return jsonResponse(reply, 503, {
          error:
            "AI classification could not understand that description. Choose a category manually.",
        });
      }
      return jsonResponse(reply, 200, {
        data: {
          category: result.category,
          summary: result.summary,
          source: "gemini" as const,
        },
      });
    } catch (error) {
      if (error instanceof ClassificationError) {
        if (error.code !== "invalid_input") {
          app.log.warn({
            msg: "Fault classification failed",
            code: error.code,
          });
        }
        switch (error.code) {
          case "not_configured":
            return jsonResponse(reply, 503, {
              error:
                "AI classification is not available right now. Choose a category manually.",
            });
          case "rate_limited":
            return jsonResponse(reply, 503, {
              error:
                "AI classification is busy right now. Choose a category manually and try again later.",
            });
          case "provider_timeout":
            return jsonResponse(reply, 503, {
              error: "AI classification timed out. Choose a category manually.",
            });
          case "invalid_input":
            return jsonResponse(reply, 400, { error: error.message });
          default:
            return jsonResponse(reply, 503, {
              error:
                "AI classification could not understand that description. Choose a category manually.",
            });
        }
      }
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "AI classification failed" });
    }
  },
);

/**
 * GET /api/v1/requests/:id
 * Ownership (§23): administrator, the owning customer, or a technician
 * already holding an offer on this request (its respond flow hydrates the
 * request). Everyone else — including valid UUIDs of other users — gets a
 * uniform 404 so existence never leaks.
 */
app.get(
  "/api/v1/requests/:id",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const row = await loadRequestForUser(id, authUser); // throws 400/404 → error handler

    /* Task 36 (Stage 3): the request detail page needs the assigned
     * technician's name and the conversation id without two extra round
     * trips. Both are additive response fields derived from the same
     * ownership-scoped row; absence stays null, never fabricated. */
    const extras = await loadRequestDetailExtras(row.id);

    const req: ServiceRequestApi = {
      id: row.id,
      description: row.description,
      category: row.category,
      city: row.city,
      status: toRequestStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      assignedTechnicianName: extras?.technicianName ?? null,
      conversationId: extras?.conversationId ?? null,
    };
    return jsonResponse(reply, 200, { data: req });
  },
);

/**
 * POST /api/v1/requests/:id/retry — ask dispatch to look again (Task 36,
 * Stage 4). Owner customer only; the backend decides retryability: only a
 * request that is still unmatched (`no_match` or a legacy stuck `pending`)
 * with no accepted offer is eligible. On success the request is either
 * re-offered (status → matching, new pending offer) or it stays no_match
 * with a fresh dispatch attempt timestamp.
 */
app.post(
  "/api/v1/requests/:id/retry",
  {
    preHandler: requireRole("customer"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 30) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    try {
      assertUuid(id);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    const owned = await loadRequestForUser(id, authUser); // 400/404 → error handler
    if (owned.customer_user_id !== authUser.id) {
      return jsonResponse(reply, 403, {
        error: "Only the customer who owns this request may retry dispatch",
      });
    }
    const outcome = await retryDispatchForRequest(id, {
      id: authUser.id,
      role: authUser.role,
    });
    if (!outcome) {
      return jsonResponse(reply, 409, {
        error: "This request cannot be retried right now",
      });
    }
    if (outcome.nextOffer?.technicianUserId) {
      try {
        await recordAndDeliverEvent(
          {
            userId: outcome.nextOffer.technicianUserId,
            type: "dispatch_offer_created",
            title: "New service offer",
            message: `You have a new ${owned.category} service offer in ${owned.city}.`,
            referenceType: "service_request",
            referenceId: id,
            channel: "in_app",
          },
          (error) => app.log.error(error),
        );
      } catch (notifyError) {
        app.log.error(notifyError);
      }
    }
    const row = await loadRequestForUser(id, authUser);
    const extras = await loadRequestDetailExtras(id);
    const req: ServiceRequestApi = {
      id: row.id,
      description: row.description,
      category: row.category,
      city: row.city,
      status: toRequestStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      assignedTechnicianName: extras?.technicianName ?? null,
      conversationId: extras?.conversationId ?? null,
    };
    return jsonResponse(reply, 200, {
      data: req,
      meta: { dispatch: outcome.nextOffer ? "offered" : "no_candidate" },
    });
  },
);

/**
 * PATCH /api/v1/requests/:id/status — server-enforced lifecycle (Task 36,
 * Stage 5; findings #11 and #12).
 *
 * The old handler validated the status vocabulary but not the transition: a
 * customer could mark an unmatched request completed, a technician holding a
 * mere pending offer could fabricate an assignment by writing 'matched', and
 * nothing was audited. This route is now a transition matrix applied inside
 * ONE transaction with a `service_request_events` audit row per real
 * transition:
 *
 *   same status → no-op success (idempotent retry from old clients)
 *   customer (owner)
 *     pending | matching | matched | in_progress → cancelled  (withdraw)
 *     in_progress → completed                                 (confirm completion)
 *   technician (must hold the ACCEPTED offer on this request)
 *     matched → in_progress                                   (start work)
 *     in_progress → completed                                 (record completion)
 *   administrator → any transition (operator override, always audited)
 *
 * completed/cancelled are closed records for customers and technicians —
 * changing them further is refused (409) so history is never rewritten.
 * Cancellation closes every still-pending offer (dispatch_offers keeps the
 * fixed four-value status vocabulary, so they are closed as 'rejected'; the
 * audit row records that the CUSTOMER ended them) and releases the accepted
 * technician's workload. Completion releases the workload too. Notifications
 * fire only after the transaction has committed.
 */

/** One lifecycle-transition decision (role-aware, from-state aware). */
function evaluateRequestTransition(
  from: string,
  to: string,
  role: UserRole,
): { ok: true } | { ok: false; code: number; error: string } {
  if (from === to) {
    return { ok: true }; // same-status write stays a successful no-op
  }
  if (role === "administrator") {
    return { ok: true }; // operator override — recorded in the audit trail
  }
  if (from === "completed" || from === "cancelled") {
    return {
      ok: false,
      code: 409,
      error: `This request is ${from} and cannot be reopened`,
    };
  }
  if (role === "customer") {
    if (to === "cancelled") {
      return ["pending", "matching", "matched", "in_progress"].includes(from)
        ? { ok: true }
        : {
            ok: false,
            code: 409,
            error: `A request that is ${from} cannot be cancelled`,
          };
    }
    if (to === "completed") {
      return from === "in_progress"
        ? { ok: true }
        : {
            ok: false,
            code: 409,
            error:
              "A request can only be marked completed after work has started",
          };
    }
    return {
      ok: false,
      code: 409,
      error:
        "Customers may cancel a request or confirm its completion — all other status changes belong to dispatch",
    };
  }
  // technician
  if (from === "matched" && to === "in_progress") return { ok: true };
  if (from === "in_progress" && to === "completed") return { ok: true };
  return {
    ok: false,
    code: 403,
    error:
      "Technicians may only start an awarded job or record its completion",
  };
}

/** Audit reason recorded in service_request_events for this transition. */
function statusChangeReason(role: UserRole, to: string): string {
  if (role === "administrator") return "admin_status_update";
  if (to === "cancelled") return "customer_cancelled";
  if (to === "completed") {
    return role === "technician"
      ? "technician_completed"
      : "customer_confirmed_completion";
  }
  return role === "technician" ? "technician_started" : "status_update";
}

app.patch(
  "/api/v1/requests/:id/status",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };

    if (
      !status ||
      !(SERVICE_REQUEST_STATUSES as readonly string[]).includes(status)
    ) {
      return jsonResponse(reply, 400, { error: "Invalid status value" });
    }
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const owned = await loadRequestForUser(id, authUser); // 400/404 → error handler

    // Same-status writes stay successful no-ops (idempotent old clients): no
    // transition, no audit row, no notification — the current row is echoed.
    if (owned.status === status) {
      const req: ServiceRequestApi = {
        id: owned.id,
        description: owned.description,
        category: owned.category,
        city: owned.city,
        status: toRequestStatus(owned.status),
        createdAt: owned.created_at,
        updatedAt: owned.updated_at,
      };
      return jsonResponse(reply, 200, { data: req });
    }

    const decision = evaluateRequestTransition(
      owned.status,
      status,
      authUser.role,
    );
    if (!decision.ok) {
      return jsonResponse(reply, decision.code, { error: decision.error });
    }

    type StatusWriteOutcome =
      | { applied: true; previousStatus: string }
      | { applied: false; code: number; error: string; idempotent?: boolean };

    try {
      const outcome = await transaction(async (client: PoolClient): Promise<StatusWriteOutcome> => {
        // Re-read under the row lock: the status may have changed between the
        // ownership read and this transaction (two tabs, a concurrent accept,
        // a cancellation racing a completion).
        const locked = await client.query<{ status: string }>(
          "SELECT status FROM service_requests WHERE id = $1 FOR UPDATE",
          [owned.id],
        );
        const current = locked.rows[0]?.status;
        if (!current) {
          return {
            applied: false,
            code: 404,
            error: "Service request not found",
          };
        }
        if (current === status) {
          return { applied: false, code: 200, error: "", idempotent: true };
        }
        const recheck = evaluateRequestTransition(current, status, authUser.role);
        if (!recheck.ok) {
          return { applied: false, code: recheck.code, error: recheck.error };
        }

        // Awarded-work guard: starting or completing work is a statement about
        // work THIS technician was awarded, so it requires their own ACCEPTED
        // offer on this request, re-checked inside the transaction. A mere
        // pending (or rejected/timed_out) offer is not enough.
        if (authUser.role === "technician") {
          const awarded = await client.query<{ id: string }>(
            `SELECT o.id FROM dispatch_offers o
               JOIN technicians t ON t.id = o.technician_id
              WHERE o.request_id = $1 AND t.user_id = $2 AND o.status = 'accepted'
              LIMIT 1`,
            [owned.id, authUser.id],
          );
          if (awarded.rows.length === 0) {
            return {
              applied: false,
              code: 403,
              error:
                "Forbidden: only the technician awarded this request may record progress or completion",
            };
          }
        }

        await client.query(
          "UPDATE service_requests SET status = $1, updated_at = NOW() WHERE id = $2",
          [status, owned.id],
        );
        // Phase 7 requirement 10 — every real transition is audited with its
        // actor, role and reason, atomically with the change itself.
        await recordRequestEvent(client, {
          requestId: owned.id,
          fromStatus: current,
          toStatus: status,
          actorUserId: authUser.id,
          actorRole: authUser.role,
          reason: statusChangeReason(authUser.role, status),
        });

        // Cancellation cascade (Stage 5): pending offers are dead the moment
        // the request is withdrawn — no more dispatch noise for a request the
        // customer has ended. dispatch_offers uses the fixed four-value status
        // vocabulary, so they are closed as 'rejected'; the audit row above is
        // what records that the customer — not a technician — ended them.
        if (status === "cancelled") {
          await client.query(
            `UPDATE dispatch_offers SET status = 'rejected', updated_at = NOW()
              WHERE request_id = $1 AND status = 'pending'`,
            [owned.id],
          );
        }
        // Completed or cancelled work frees the assigned technician's
        // workload slot. releaseTechnicianCapacity only restores availability
        // that was set automatically (availability_auto) — a manual
        // "unavailable" toggle is never overridden.
        if (status === "cancelled" || status === "completed") {
          const accepted = await client.query<{ technician_id: string }>(
            `SELECT technician_id FROM dispatch_offers
              WHERE request_id = $1 AND status = 'accepted'
              ORDER BY updated_at DESC LIMIT 1`,
            [owned.id],
          );
          const techId = accepted.rows[0]?.technician_id;
          if (techId) {
            await releaseTechnicianCapacity(client, techId);
          }
        }
        return { applied: true, previousStatus: current };
      });

      if (!outcome.applied) {
        if (outcome.idempotent) {
          // Lost the race to an identical write — the request is already in
          // the requested state; echo it as the no-op success it is.
          const req: ServiceRequestApi = {
            id: owned.id,
            description: owned.description,
            category: owned.category,
            city: owned.city,
            status: toRequestStatus(status),
            createdAt: owned.created_at,
            updatedAt: owned.updated_at,
          };
          return jsonResponse(reply, 200, { data: req });
        }
        return jsonResponse(reply, outcome.code, {
          error: outcome.error || "Failed to update request status",
        });
      }

      // Other participant(s) only — never the actor; missing recipients skip
      // safely. A notification failure is logged but never fails the
      // already-committed status change.
      await notifyRequestStatusChange({
        requestId: owned.id,
        category: owned.category,
        city: owned.city,
        newStatus: toRequestStatus(status),
        actorUserId: authUser.id,
        customerUserId: owned.customer_user_id,
        onError: (error) => app.log.error(error),
      });

      const req: ServiceRequestApi = {
        id: owned.id,
        description: owned.description,
        category: owned.category,
        city: owned.city,
        status: toRequestStatus(status),
        createdAt: owned.created_at,
        updatedAt: owned.updated_at,
      };
      return jsonResponse(reply, 200, { data: req });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to update request status",
      });
    }
  },
);

/**
 * GET /api/v1/offers/technician/:technicianId
 * A technician may read ONLY the collection keyed by their own profile id
 * (the id is derived from the authenticated user → technicians.user_id —
 * never trusted from the browser); administrators may read any.
 */
app.get(
  "/api/v1/offers/technician/:technicianId",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { technicianId } = request.params as { technicianId: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    await assertTechnicianOfferCollection(technicianId, authUser); // 400/403 → error handler
    try {
      const rows = await query<{
        id: string;
        request_id: string;
        technician_id: string;
        candidate_index: number;
        status: string;
        created_at: string;
        updated_at: string;
      }>(
        "SELECT id, request_id, technician_id, candidate_index, status, created_at, updated_at FROM dispatch_offers WHERE technician_id = $1 ORDER BY created_at DESC",
        [technicianId],
      );
      const offers: OfferApi[] = rows.map((r) => ({
        id: r.id,
        requestId: r.request_id,
        technicianId: r.technician_id,
        candidateIndex: r.candidate_index,
        status: toOfferStatus(r.status),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return jsonResponse(reply, 200, { data: offers });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to fetch technician offers",
      });
    }
  },
);

/**
 * Task 28.2D4 — request-status notification copy. Titles are per status;
 * messages are audience-specific (the customer owns the request, the
 * technician accepted the job). Labels are grammatical after "is now".
 */
const REQUEST_STATUS_TITLES: Record<ServiceRequestStatus, string> = {
  pending: "Request pending",
  matching: "Finding a technician",
  matched: "Technician matched",
  no_match: "No technician found",
  in_progress: "Service in progress",
  completed: "Service completed",
  cancelled: "Request cancelled",
};

const REQUEST_STATUS_LABELS: Record<ServiceRequestStatus, string> = {
  pending: "pending",
  matching: "being matched",
  matched: "matched",
  no_match: "closed with no match",
  in_progress: "in progress",
  completed: "completed",
  cancelled: "cancelled",
};

/**
 * Task 28.2D6 — record one event notification, then attempt real Web Push
 * delivery for it (post-commit: the D1 transaction has already committed
 * before delivery starts, so no DB transaction is ever held open across
 * the network call). Delivery runs only for freshly created rows —
 * natural-key dedupe hits are never re-pushed. Every failure (record or
 * delivery) is reported via onError without ever failing the business
 * operation that triggered the event.
 */
async function recordAndDeliverEvent(
  params: RecordEventNotificationParams,
  onError: (error: unknown) => void,
): Promise<void> {
  let result;
  try {
    result = await NotificationService.recordEventNotification(params);
  } catch (error) {
    onError(error);
    return;
  }
  if (!result.created) {
    return;
  }
  try {
    await NotificationService.deliverPendingNotification(
      result.notification.id,
    );
  } catch (error) {
    onError(error);
  }
}

/**
 * Notify the OTHER participant(s) of a service-request status change (D1
 * natural-key dedupe applies per recipient). The actor is identified by id
 * comparison — never notified about their own action:
 *   - customer actor → the accepted technician's linked user (if any);
 *   - technician actor → the owning customer;
 *   - administrator actor → both non-actor participants.
 * Each recipient insert is isolated: one failure is reported via onError
 * without skipping the others. Throws nothing itself.
 */
async function notifyRequestStatusChange(args: {
  requestId: string;
  category: string;
  city: string;
  newStatus: ServiceRequestStatus;
  actorUserId: string;
  customerUserId: string | null;
  onError: (error: unknown) => void;
}): Promise<void> {
  const recipients: Array<{
    userId: string;
    audience: "customer" | "technician";
  }> = [];
  if (args.customerUserId && args.customerUserId !== args.actorUserId) {
    recipients.push({ userId: args.customerUserId, audience: "customer" });
  }
  const accepted = await loadAcceptedTechnician(args.requestId);
  if (accepted) {
    const techUser = await query<{ user_id: string | null }>(
      "SELECT user_id FROM technicians WHERE id = $1",
      [accepted.technician_id],
    );
    const techUserId = techUser[0]?.user_id ?? null;
    if (techUserId && techUserId !== args.actorUserId) {
      recipients.push({ userId: techUserId, audience: "technician" });
    }
  }
  const label = REQUEST_STATUS_LABELS[args.newStatus];
  for (const recipient of recipients) {
    const message =
      recipient.audience === "customer"
        ? `Your ${args.category} service request in ${args.city} is now ${label}.`
        : `A ${args.category} service request in ${args.city} you accepted is now ${label}.`;
    try {
      await recordAndDeliverEvent(
        {
          userId: recipient.userId,
          type: `request_status_${args.newStatus}`,
          title: REQUEST_STATUS_TITLES[args.newStatus],
          message,
          referenceType: "service_request",
          referenceId: args.requestId,
          channel: "in_app",
        },
        args.onError,
      );
    } catch (error) {
      args.onError(error);
    }
  }
}

/**
 * POST /api/v1/offers/:offerId/accept
 * Authorization: the technician who owns the offer, the customer who owns
 * the request the offer sits on (customer-side accept on /matching), or an
 * administrator. Another technician changing the URL gets 404 — the offer
 * is indistinguishable from one that does not exist.
 */
/**
 * Task 28.2D3 — offer-outcome notification copy (customer-facing).
 * Emitted only for genuine pending → terminal transitions; the caller
 * guards on the pre-write status and isolates failures (log + continue).
 */
const OFFER_OUTCOME_COPY = {
  accepted: { type: "dispatch_offer_accepted", title: "Offer accepted" },
  rejected: { type: "dispatch_offer_rejected", title: "Offer rejected" },
  timed_out: { type: "dispatch_offer_timed_out", title: "Offer expired" },
} as const;

type OfferOutcome = keyof typeof OFFER_OUTCOME_COPY;

function offerOutcomeMessage(
  outcome: OfferOutcome,
  request: { category: string; city: string },
): string {
  if (outcome === "accepted") {
    return `Your ${request.category} service request in ${request.city} was accepted.`;
  }
  if (outcome === "rejected") {
    return `An offer for your ${request.category} service request in ${request.city} was rejected.`;
  }
  return `An offer for your ${request.category} service request in ${request.city} expired without a response.`;
}

/**
 * Record an offer-outcome notification for the request customer (D1
 * natural-key dedupe applies; NULL customer_user_id safely skips), then
 * attempt push delivery for freshly created rows (D6). Failures are
 * reported via onError — the caller's 200 response is never affected.
 */
async function notifyOfferOutcome(
  offerId: string,
  request: {
    category: string;
    city: string;
    customer_user_id: string | null;
  },
  outcome: OfferOutcome,
  onError: (error: unknown) => void,
): Promise<void> {
  const copy = OFFER_OUTCOME_COPY[outcome];
  await recordAndDeliverEvent(
    {
      userId: request.customer_user_id,
      type: copy.type,
      title: copy.title,
      message: offerOutcomeMessage(outcome, request),
      referenceType: "dispatch_offer",
      referenceId: offerId,
      channel: "in_app",
    },
    onError,
  );
}

app.post(
  "/api/v1/offers/:offerId/accept",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { offerId } = request.params as { offerId: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    // Authorization FIRST (unchanged contract): the offer's technician, the
    // owning customer, or an administrator. Strangers get the uniform 404.
    const { request: serviceRequest } = await loadOfferForResponse(offerId, authUser);

    /* Task 36 (Stage 5) — ATOMIC ASSIGNMENT.
     *
     * The old handler ran an unconditional UPDATE with no status predicate,
     * no request lock, no already-assigned guard, no eligibility/workload
     * re-check, and a conversation creation whose failure answered 500 AFTER
     * the offer and request had already changed. Two technicians could win
     * the same request; a suspended technician could still accept.
     *
     * assignOfferAtomically performs the whole assignment in ONE transaction:
     * lock offer + request → guard offer pending & request open → re-check
     * technician eligibility and workload cap → conditional offer update →
     * conditional request update → close competing pending offers → create
     * the conversation → audit event → availability at cap. Any guard failure
     * throws HttpError and rolls EVERYTHING back; the database stays the
     * source of truth. Notifications are sent only after commit.
     */
    const result = await assignOfferAtomically(offerId, {
      id: authUser.id,
      role: authUser.role,
    });

    if (!result.alreadyAssigned) {
      // Offer-outcome notification to the OTHER party (dedupe keeps the
      // historical key stable). The duplicate second call the old handler
      // made inside the conversation block is gone (finding #14).
      try {
        await notifyOfferOutcome(
          offerId,
          serviceRequest,
          "accepted",
          (error) => app.log.error(error),
        );
      } catch (notifyError) {
        app.log.error(notifyError);
      }
      if (result.closedCompetingOffers > 0) {
        app.log.info({
          msg: "Competing pending offers closed by accepted offer",
          requestId: serviceRequest.id,
          offerId,
          closed: result.closedCompetingOffers,
        });
      }
      if (!result.conversationCreated) {
        // Assignment committed, chat could not be created (legacy NULL
        // customer link). The frontend treats a missing conversation as
        // "communication not yet unlocked" — never a fabricated success.
        app.log.error({
          msg: "Offer accepted but conversation was not created",
          requestId: serviceRequest.id,
          offerId,
        });
      }
    }

    const offer: OfferApi = {
      id: result.offer.id,
      requestId: result.offer.requestId,
      technicianId: result.offer.technicianId,
      candidateIndex: result.offer.candidateIndex,
      status: toOfferStatus(result.offer.status),
      createdAt: result.offer.createdAt,
      updatedAt: result.offer.updatedAt,
    };
    return jsonResponse(reply, 200, { data: offer });
  },
);

/**
 * POST /api/v1/offers/:offerId/reject
 * Same ownership rule as /accept: offer owner technician, owning customer,
 * or administrator.
 */
app.post(
  "/api/v1/offers/:offerId/reject",
  { preHandler: requireAuth },
  async (request, reply) => {
    return handleOfferOutcome(request, reply, "rejected");
  },
);

/**
 * POST /api/v1/offers/:offerId/timeout
 * Same ownership rule as /accept: offer owner technician, owning customer,
 * or administrator.
 */
app.post(
  "/api/v1/offers/:offerId/timeout",
  { preHandler: requireAuth },
  async (request, reply) => {
    return handleOfferOutcome(request, reply, "timed_out");
  },
);

/**
 * Task 36 (Stage 4) — server-side cascade for reject/timeout.
 *
 * The browser used to decide the next candidate after a reject/timeout; a
 * closed tab therefore stranded the request in `matching` forever (finding
 * #4). processOfferOutcome now applies the outcome inside one transaction
 * AND advances dispatch: next eligible candidate → new pending offer, else
 * the request falls back to `no_match` with an audit row. Both outcomes are
 * committed before any notification is sent, and a stale pending offer on an
 * already-resolved request is closed without a cascade.
 */
async function handleOfferOutcome(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: "rejected" | "timed_out",
) {
  const { offerId } = request.params as { offerId: string };
  const authUser = request.authUser;
  if (!authUser) {
    return jsonResponse(reply, 401, { error: "Authentication required" });
  }
  // Authorization FIRST (unchanged contract, same as /accept).
  await loadOfferForResponse(offerId, authUser); // 400/404 → error handler

  const result = await processOfferOutcome(offerId, outcome);
  if (!result) {
    return jsonResponse(reply, 404, { error: "Offer not found" });
  }

  if (result.offerUpdated) {
    try {
      await notifyOfferOutcome(
        offerId,
        {
          category: result.requestCategory,
          city: result.requestCity,
          customer_user_id: result.customerUserId,
        },
        outcome,
        (error) => app.log.error(error),
      );
    } catch (notifyError) {
      app.log.error(notifyError);
    }
    if (result.nextOffer) {
      // The next ranked technician was offered the job after commit.
      try {
        if (result.nextOffer.technicianUserId) {
          await recordAndDeliverEvent(
            {
              userId: result.nextOffer.technicianUserId,
              type: "dispatch_offer_created",
              title: "New service offer",
              message: `You have a new ${result.requestCategory} service offer in ${result.requestCity}.`,
              referenceType: "service_request",
              referenceId: result.requestId,
              channel: "in_app",
            },
            (error) => app.log.error(error),
          );
        }
      } catch (notifyError) {
        app.log.error(notifyError);
      }
    }
    if (result.requestStatusAfter === "no_match") {
      // All candidates are exhausted — the customer is told honestly.
      try {
        await notifyRequestStatusChange({
          requestId: result.requestId,
          category: result.requestCategory,
          city: result.requestCity,
          newStatus: "no_match",
          actorUserId: authUser.id,
          customerUserId: result.customerUserId,
          onError: (error) => app.log.error(error),
        });
      } catch (notifyError) {
        app.log.error(notifyError);
      }
    }
  }

  const offer: OfferApi | null = result.offer
    ? {
        id: result.offer.id,
        requestId: result.offer.requestId,
        technicianId: result.offer.technicianId,
        candidateIndex: result.offer.candidateIndex,
        status: toOfferStatus(result.offer.status),
        createdAt: result.offer.createdAt,
        updatedAt: result.offer.updatedAt,
      }
    : null;
  if (!offer) {
    return jsonResponse(reply, 404, { error: "Offer not found" });
  }
  return jsonResponse(reply, 200, { data: offer });
}

/**
 * POST /api/v1/offers
 * Create a new dispatched offer, persisting it to the database.
 * Stores: requestId, technicianId, candidateIndex, status, timestamps.
 * Authorization: write access to the OWNING request (owner customer /
 * technician participant / administrator) plus a technician target that
 * exists. The technicianId here is the dispatch target chosen by the
 * existing pipeline — it is never interpreted as the caller's identity.
 */
app.post(
  "/api/v1/offers",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_OFFERS", 60) },
  },
  async (request, reply) => {
    const { requestId, technicianId, candidateIndex, status } =
      request.body as {
        requestId: string;
        technicianId: string;
        candidateIndex: number;
        status: string;
      };

    if (
      !requestId ||
      !technicianId ||
      candidateIndex === undefined ||
      status === undefined
    ) {
      return jsonResponse(reply, 400, {
        error: "Missing required offer fields",
      });
    }

    /* Task 36 (Stage 5, finding #13): the API creates PENDING offers only.
     * A browser can no longer fabricate `accepted`/`rejected`/`timed_out`
     * dispatch decisions by POSTing a terminal status — outcomes are the
     * exclusive business of the outcome endpoints and the sweeper. The
     * candidate index is server-bounded: a non-integer, negative or absurd
     * value is rejected before it can distort cascade order. */
    if (status !== "pending") {
      return jsonResponse(reply, 400, {
        error: "Offers can only be created with status 'pending'",
      });
    }
    if (
      !Number.isInteger(candidateIndex) ||
      candidateIndex < 0 ||
      candidateIndex > 1000
    ) {
      return jsonResponse(reply, 400, {
        error: "candidateIndex must be a non-negative integer",
      });
    }

    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const owned = await assertOfferCreateAccess(
      requestId,
      technicianId,
      authUser,
    ); // 400/404
    // Task 28 §6 — mandatory server-side eligibility gate. Runs OUTSIDE the
    // try/catch below so its HttpError (409/422/404) reaches the central error
    // handler with the correct status instead of being masked as a 500.
    await assertOfferEligibility(owned, technicianId);

    try {
      const result = await query<{
        id: string;
        request_id: string;
        technician_id: string;
        candidate_index: number;
        status: string;
        created_at: string;
        updated_at: string;
      }>(
        `INSERT INTO dispatch_offers (request_id, technician_id, candidate_index, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
        [owned.id, technicianId, candidateIndex, status],
      );
      if (result.length === 0) {
        return jsonResponse(reply, 500, { error: "Failed to create offer" });
      }
      const offer: OfferApi = {
        id: result[0].id,
        requestId: result[0].request_id,
        technicianId: result[0].technician_id,
        candidateIndex: result[0].candidate_index,
        status: toOfferStatus(result[0].status),
        createdAt: result[0].created_at,
        updatedAt: result[0].updated_at,
      };
      // Task 28.2D2 — offer-created notification, recorded ONLY after the
      // offer INSERT succeeded. The recipient is the target technician's
      // linked user (NULL for seed/legacy profiles → the helper safely
      // skips). Delivery is attempted for freshly created rows (D6). A
      // notification failure is logged but never fails the already-created
      // offer — no distributed transaction.
      try {
        const techUser = await query<{ user_id: string | null }>(
          "SELECT user_id FROM technicians WHERE id = $1",
          [technicianId],
        );
        await recordAndDeliverEvent(
          {
            userId: techUser[0]?.user_id ?? null,
            type: "dispatch_offer_created",
            title: "New service offer",
            message: `You have a new ${owned.category} service offer in ${owned.city}.`,
            referenceType: "dispatch_offer",
            referenceId: offer.id,
            channel: "in_app",
          },
          (error) => app.log.error(error),
        );
      } catch (error) {
        app.log.error(error);
      }
      return jsonResponse(reply, 201, { data: offer });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to create offer" });
    }
  },
);

/**
 * GET /api/v1/categories
 */
app.get("/api/v1/categories", async (_, reply) => {
  return jsonResponse(reply, 200, { data: categories });
});

/**
 * POST /api/v1/classify
 */
app.post("/api/v1/classify", async (request, reply) => {
  const { description } = request.body as { description: string };
  if (!description || description.length < 1 || description.length > 2000) {
    return jsonResponse(reply, 400, {
      error: "Description must be 1-2000 characters",
    });
  }

  const t = description.toLowerCase();
  const category =
    t.match(/leak|tap|pipe|toilet|drain/)?.input ??
    t.match(/wire|socket|power|light|breaker|electric/)?.input ??
    t.match(/car|engine|brake|tyre|vehicle/)?.input ??
    t.match(/laptop|computer|wifi|network|software|phone/)?.input ??
    t.match(/fridge|oven|washing machine|appliance/)?.input ??
    null;

  return jsonResponse(reply, 200, {
    data: {
      suggestion: category,
      method: "keyword-baseline",
      requiresUserConfirmation: true,
    },
  });
});

/**
 * GET /api/v1/requests/:requestId/offers
 * All dispatch offers recorded for one service request, oldest first.
 * Visibility: the owning customer, a technician holding an offer on this
 * request, or an administrator — customers can never list another
 * customer's offers (§27).
 */
app.get(
  "/api/v1/requests/:requestId/offers",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const owned = await loadRequestForUser(requestId, authUser); // 400/404 → error handler
    try {
      const rows = await query<{
        id: string;
        request_id: string;
        technician_id: string;
        candidate_index: number;
        status: string;
        created_at: string;
        updated_at: string;
      }>(
        "SELECT id, request_id, technician_id, candidate_index, status, created_at, updated_at FROM dispatch_offers WHERE request_id = $1 ORDER BY candidate_index ASC",
        [owned.id],
      );
      const offers: OfferApi[] = rows.map((r) => ({
        id: r.id,
        requestId: r.request_id,
        technicianId: r.technician_id,
        candidateIndex: r.candidate_index,
        status: toOfferStatus(r.status),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return jsonResponse(reply, 200, { data: offers });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to fetch request offers",
      });
    }
  },
);

/**
 * GET /api/v1/admin/users — the minimum administrative surface needed to
 * prove administrator authorization (§22). Safe fields only: no password
 * material, no session data. Administrator role only.
 */
app.get(
  "/api/v1/admin/users",
  { preHandler: requireRole("administrator") },
  async (_, reply) => {
    try {
      const rows = await query<{
        id: string;
        email: string;
        role: string;
        first_name: string;
        last_name: string;
        account_status: string;
        created_at: string;
      }>(
        `SELECT id, email, role, first_name, last_name, account_status, created_at
       FROM users ORDER BY created_at ASC`,
      );
      return jsonResponse(reply, 200, {
        data: rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          firstName: r.first_name,
          lastName: r.last_name,
          accountStatus: r.account_status,
          createdAt: r.created_at,
        })),
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to fetch users" });
    }
  },
);

/**
 * GET /api/v1/admin/overview — Task 25 platform overview for administrators.
 * Every figure is a direct aggregate over real rows (COUNT/FILTER/GROUP BY);
 * nothing is estimated or fabricated. `requests.open` is the arithmetic sum
 * of pending + matching + matched + in_progress (documented in
 * AdminOverviewApi). Recent activity merges the newest request, account,
 * and offer rows (6 each) and returns the 10 newest, newest first.
 */
app.get(
  "/api/v1/admin/overview",
  { preHandler: requireRole("administrator") },
  async (_, reply) => {
    try {
      const [
        userTotals,
        userByRole,
        userStatus,
        technicianTotals,
        requestByStatus,
        offerByStatus,
        recentRequests,
        recentUsers,
        recentOffers,
      ] = await Promise.all([
        query<{
          total: number;
          active: number;
          suspended: number;
          disabled: number;
        }>(
          `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE account_status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE account_status = 'suspended')::int AS suspended,
                COUNT(*) FILTER (WHERE account_status = 'disabled')::int AS disabled
         FROM users`,
        ),
        query<{ role: string; count: number }>(
          "SELECT role, COUNT(*)::int AS count FROM users GROUP BY role",
        ),
        query<{ active: number; suspended: number; disabled: number }>(
          `SELECT COUNT(*) FILTER (WHERE account_status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE account_status = 'suspended')::int AS suspended,
                COUNT(*) FILTER (WHERE account_status = 'disabled')::int AS disabled
         FROM users`,
        ),
        query<{
          total: number;
          active: number;
          available: number;
          verified: number;
        }>(
          `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE account_status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE availability_status = 'available')::int AS available,
                COUNT(*) FILTER (WHERE verified)::int AS verified
         FROM technicians`,
        ),
        query<{ status: string; count: number }>(
          "SELECT status, COUNT(*)::int AS count FROM service_requests GROUP BY status",
        ),
        query<{ status: string; count: number }>(
          "SELECT status, COUNT(*)::int AS count FROM dispatch_offers GROUP BY status",
        ),
        query<{
          id: string;
          category: string;
          city: string;
          status: string;
          created_at: string;
        }>(
          "SELECT id, category, city, status, created_at FROM service_requests ORDER BY created_at DESC LIMIT 6",
        ),
        query<{ id: string; email: string; role: string; created_at: string }>(
          "SELECT id, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 6",
        ),
        query<{
          id: string;
          status: string;
          created_at: string;
          technician_name: string;
          category: string;
        }>(
          `SELECT o.id, o.status, o.created_at, t.name AS technician_name, r.category
         FROM dispatch_offers o
         JOIN technicians t ON t.id = o.technician_id
         JOIN service_requests r ON r.id = o.request_id
         ORDER BY o.created_at DESC LIMIT 6`,
        ),
      ]);

      // Role counts, zero-filled for roles that have no rows yet.
      const byRole = {
        customer: 0,
        technician: 0,
        administrator: 0,
      } as AdminOverviewApi["users"]["byRole"];
      for (const row of userByRole) {
        if (
          row.role === "customer" ||
          row.role === "technician" ||
          row.role === "administrator"
        ) {
          byRole[row.role] = row.count;
        }
      }

      // Request counts by status, zero-filled over the full vocabulary.
      const byStatus = {
        pending: 0,
        matching: 0,
        matched: 0,
        no_match: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0,
      } as AdminOverviewApi["requests"]["byStatus"];
      for (const row of requestByStatus) {
        byStatus[toRequestStatus(row.status)] = row.count;
      }
      const open =
        byStatus.pending +
        byStatus.matching +
        byStatus.matched +
        byStatus.in_progress;

      const offerCounts = {
        pending: 0,
        accepted: 0,
        rejected: 0,
        timed_out: 0,
      };
      for (const row of offerByStatus) {
        offerCounts[toOfferStatus(row.status)] = row.count;
      }

      // Merged recent activity — newest first, capped at 10 events.
      const activity: AdminActivityEventApi[] = [
        ...recentRequests.map((r) => ({
          kind: "request" as const,
          id: r.id,
          category: r.category,
          city: r.city,
          status: toRequestStatus(r.status),
          at: r.created_at,
        })),
        ...recentUsers.map((u) => ({
          kind: "user" as const,
          id: u.id,
          email: u.email,
          // role is protected by a database CHECK constraint.
          role: u.role as UserRole,
          at: u.created_at,
        })),
        ...recentOffers.map((o) => ({
          kind: "offer" as const,
          id: o.id,
          technicianName: o.technician_name,
          category: o.category,
          status: toOfferStatus(o.status),
          at: o.created_at,
        })),
      ]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 10);

      const overview: AdminOverviewApi = {
        users: {
          total: userTotals[0].total,
          byRole,
          active: userStatus[0].active,
          suspended: userStatus[0].suspended,
          disabled: userStatus[0].disabled,
        },
        technicians: {
          total: technicianTotals[0].total,
          active: technicianTotals[0].active,
          available: technicianTotals[0].available,
          verified: technicianTotals[0].verified,
          unverified: technicianTotals[0].total - technicianTotals[0].verified,
        },
        requests: {
          total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
          byStatus,
          open,
          completed: byStatus.completed,
          cancelled: byStatus.cancelled,
          noMatch: byStatus.no_match,
        },
        offers: {
          total:
            offerCounts.pending +
            offerCounts.accepted +
            offerCounts.rejected +
            offerCounts.timed_out,
          pending: offerCounts.pending,
          accepted: offerCounts.accepted,
          rejected: offerCounts.rejected,
          timedOut: offerCounts.timed_out,
        },
        recent: activity,
      };
      return jsonResponse(reply, 200, { data: overview });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to fetch platform overview",
      });
    }
  },
);

/**
 * GET /api/v1/admin/technicians — administrator technician management view.
 * Profile rows LEFT JOINed to their linked account (seed prototype profiles
 * have no account → userId/userEmail are null). Safe fields only.
 */
app.get(
  "/api/v1/admin/technicians",
  { preHandler: requireRole("administrator") },
  async (_, reply) => {
    try {
      const rows = await query<{
        id: string;
        name: string;
        category: string;
        skills: string[];
        service_area: string;
        rating: number;
        jobs: number;
        verified: boolean;
        availability: string;
        availability_status: string;
        account_status: string;
        user_id: string | null;
        user_email: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT t.id, t.name, t.category, t.skills, t.service_area, t.rating, t.jobs,
              t.verified, t.availability, t.availability_status, t.account_status,
              u.id AS user_id, u.email AS user_email,
              t.created_at, t.updated_at
       FROM technicians t
       LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.name`,
      );
      const technicians: AdminTechnicianApi[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        skills: r.skills,
        serviceArea: r.service_area,
        rating: r.rating,
        jobs: r.jobs,
        verified: r.verified,
        availability: r.availability,
        availabilityStatus: r.availability_status,
        accountStatus: r.account_status,
        userId: r.user_id,
        userEmail: r.user_email,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return jsonResponse(reply, 200, { data: technicians });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to fetch technicians" });
    }
  },
);

/**
 * GET /api/v1/admin/requests — administrator platform monitoring view.
 * Every service request (newest first) with the owning customer's safe
 * identity (legacy pre-auth rows → null customer) and ALL dispatch offers
 * carrying the target technician's name — matching/offering and no-match
 * state are visible without touching the dispatch algorithm itself.
 */
app.get(
  "/api/v1/admin/requests",
  { preHandler: requireRole("administrator") },
  async (_, reply) => {
    try {
      const [requestRows, offerRows] = await Promise.all([
        query<{
          id: string;
          description: string;
          category: string;
          city: string;
          status: string;
          created_at: string;
          updated_at: string;
          customer_user_id: string | null;
          customer_email: string | null;
          customer_first_name: string | null;
          customer_last_name: string | null;
        }>(
          `SELECT r.id, r.description, r.category, r.city, r.status,
                r.created_at, r.updated_at, r.customer_user_id,
                u.email AS customer_email, u.first_name AS customer_first_name,
                u.last_name AS customer_last_name
         FROM service_requests r
         LEFT JOIN users u ON u.id = r.customer_user_id
         ORDER BY r.created_at DESC`,
        ),
        query<{
          id: string;
          request_id: string;
          technician_id: string;
          status: string;
          created_at: string;
          technician_name: string;
        }>(
          `SELECT o.id, o.request_id, o.technician_id, o.status, o.created_at,
                t.name AS technician_name
         FROM dispatch_offers o
         JOIN technicians t ON t.id = o.technician_id
         ORDER BY o.created_at ASC`,
        ),
      ]);

      // Group offers by request (queries are independent and unordered
      // relative to each other — grouping here avoids a second round-trip).
      const offersByRequest = new Map<string, AdminRequestApi["offers"]>();
      for (const o of offerRows) {
        const offer = {
          id: o.id,
          technicianId: o.technician_id,
          technicianName: o.technician_name,
          status: toOfferStatus(o.status),
          createdAt: o.created_at,
        };
        const list = offersByRequest.get(o.request_id);
        if (list) list.push(offer);
        else offersByRequest.set(o.request_id, [offer]);
      }

      const requests: AdminRequestApi[] = requestRows.map((r) => ({
        id: r.id,
        description: r.description,
        category: r.category,
        city: r.city,
        status: toRequestStatus(r.status),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        customerUserId: r.customer_user_id,
        customerEmail: r.customer_email,
        customerName:
          r.customer_first_name || r.customer_last_name
            ? `${r.customer_first_name ?? ""} ${r.customer_last_name ?? ""}`.trim()
            : null,
        offers: offersByRequest.get(r.id) ?? [],
      }));
      return jsonResponse(reply, 200, { data: requests });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to fetch service requests",
      });
    }
  },
);

/** Row shape returned by the account-status UPDATE RETURNING clause. */
interface AdminUserRow {
  id: string;
  email: string;
  role: string;
  first_name: string;
  last_name: string;
  account_status: string;
  created_at: string;
}

/**
 * PATCH /api/v1/admin/users/:id/status — server-authorized account
 * activation/deactivation (Task 25). Administrator role only.
 *
 * Guards: 400 invalid UUID or invalid status vocabulary; 403 when an
 * administrator tries to change their OWN status (prevents locking the
 * platform out of its only administrator); 404 unknown user. For a
 * technician account the linked technicians.account_status row is kept in
 * sync inside the same transaction so dispatch eligibility (which reads the
 * profile row, not the users row) always reflects the account decision —
 * 'disabled' maps to the profile vocabulary's 'inactive'.
 */
app.patch(
  "/api/v1/admin/users/:id/status",
  {
    preHandler: requireRole("administrator"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ADMIN", 60) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    assertUuid(id); // throws 400 → error handler

    const parsed = z
      .object({ accountStatus: z.enum(["active", "suspended", "disabled"]) })
      .safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    if (id === authUser.id) {
      return jsonResponse(reply, 403, {
        error: "You cannot change the status of your own account.",
      });
    }

    // account_status is selected (not just id/role) so the audit record can
    // state the real previous -> new transition rather than just the result.
    const target = await query<{
      id: string;
      role: string;
      account_status: string;
    }>("SELECT id, role, account_status FROM users WHERE id = $1", [id]);
    if (target.length === 0) {
      return jsonResponse(reply, 404, { error: "User not found" });
    }

    const status = parsed.data.accountStatus;
    try {
      const updated = await transaction(async (client) => {
        // `client` is typed `any` in db/client.ts — mirror authService's
        // pattern: call untyped and assert the RETURNING row shape.
        const result = await client.query(
          `UPDATE users SET account_status = $1, updated_at = NOW()
           WHERE id = $2
           RETURNING id, email, role, first_name, last_name, account_status, created_at`,
          [status, id],
        );
        if (target[0].role === "technician") {
          // Profile vocabulary: active | inactive | suspended.
          const profileStatus = status === "disabled" ? "inactive" : status;
          await client.query(
            "UPDATE technicians SET account_status = $1, updated_at = NOW() WHERE user_id = $2",
            [profileStatus, id],
          );
        }
        return result.rows as AdminUserRow[];
      });
      const row = updated[0];
      const user: AdminUserApi = {
        id: row.id,
        email: row.email,
        role: row.role as UserRole,
        firstName: row.first_name,
        lastName: row.last_name,
        accountStatus: row.account_status as AdminUserApi["accountStatus"],
        createdAt: row.created_at,
      };
      // Task 28.3F: a privileged change to someone's access is recorded.
      // The subject's email/name are NOT copied into the audit row — only the
      // opaque id and the status transition.
      await recordAuditEvent({
        eventType: "admin.user_status_changed",
        actorUserId: authUser.id,
        actorRole: authUser.role,
        targetUserId: row.id,
        targetEntityType: "user",
        targetEntityId: row.id,
        metadata: {
          previous_status: target[0].account_status,
          new_status: row.account_status,
          route: "/api/v1/admin/users/:id/status",
        },
      });
      if (status === "suspended" || status === "disabled") {
        await recordAuditEvent({
          eventType: "account.suspended",
          actorUserId: authUser.id,
          actorRole: authUser.role,
          targetUserId: row.id,
          targetEntityType: "user",
          targetEntityId: row.id,
          metadata: { new_status: status },
        });
      }
      return jsonResponse(reply, 200, { data: user });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to update account status",
      });
    }
  },
);

/* ----------------------------------------------------------------------- */
/* Task 27 — customer ratings & reviews                                     */
/* ----------------------------------------------------------------------- */

interface ReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  first_name: string;
  last_name: string;
  created_at: string;
}

/** Public-safe customer display: first name + last initial ("Chipo T."). */
function toReviewApi(row: ReviewRow): ReviewApi {
  const initial = row.last_name.trim().charAt(0);
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    customerName: initial ? `${row.first_name} ${initial}.` : row.first_name,
    createdAt: row.created_at,
  };
}

/** The technician who ACCEPTED the job on a request (the review subject). */
async function loadAcceptedTechnician(
  requestId: string,
): Promise<{ technician_id: string; technician_name: string } | null> {
  const rows = await query<{ technician_id: string; technician_name: string }>(
    `SELECT o.technician_id, t.name AS technician_name
     FROM dispatch_offers o
     JOIN technicians t ON t.id = o.technician_id
     WHERE o.request_id = $1 AND o.status = 'accepted'
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [requestId],
  );
  return rows[0] ?? null;
}

/**
 * Detail-view extras shared by GET /requests/:id and POST /requests/:id/retry
 * (Task 36, Stage 3): the accepted technician's display name and the
 * conversation id, both nullable — a request may be matched but never have
 * earned a conversation, and unmatched requests have neither.
 */
async function loadRequestDetailExtras(
  requestId: string,
): Promise<{ technicianName: string | null; conversationId: string | null } | null> {
  const rows = await query<{
    technician_name: string | null;
    conversation_id: string | null;
  }>(
    `SELECT
       (SELECT t.name FROM dispatch_offers o
          JOIN technicians t ON t.id = o.technician_id
         WHERE o.request_id = r.id AND o.status = 'accepted'
         ORDER BY o.updated_at DESC LIMIT 1) AS technician_name,
       (SELECT c.id FROM conversations c WHERE c.service_request_id = r.id
         LIMIT 1) AS conversation_id
     FROM service_requests r WHERE r.id = $1`,
    [requestId],
  );
  if (!rows[0]) return null;
  return {
    technicianName: rows[0].technician_name ?? null,
    conversationId: rows[0].conversation_id ?? null,
  };
}

async function loadReviewForRequest(
  requestId: string,
): Promise<ReviewApi | null> {
  const rows = await query<ReviewRow>(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.first_name, u.last_name
     FROM reviews r
     JOIN users u ON u.id = r.customer_id
     WHERE r.service_request_id = $1`,
    [requestId],
  );
  return rows[0] ? toReviewApi(rows[0]) : null;
}

/**
 * GET /api/v1/requests/:id/review — the review state for one request:
 * the review (when present), whether the caller may submit one now, and
 * the matched technician's name. Same visibility as the request itself
 * (owner customer, participating technician, administrator).
 */
app.get(
  "/api/v1/requests/:id/review",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const row = await loadRequestForUser(id, authUser); // throws 400/404 → error handler
    const [review, accepted] = await Promise.all([
      loadReviewForRequest(row.id),
      loadAcceptedTechnician(row.id),
    ]);
    const payload: RequestReviewApi = {
      review,
      eligible:
        row.status === "completed" &&
        accepted !== null &&
        review === null &&
        row.customer_user_id === authUser.id,
      technicianName: accepted?.technician_name ?? null,
    };
    return jsonResponse(reply, 200, { data: payload });
  },
);

const reviewCreateSchema = z
  .object({
    rating: z
      .number()
      .int("Rating must be a whole number of stars")
      .min(1)
      .max(5),
    comment: z
      .string()
      .trim()
      .min(8, "A comment needs at least 8 characters")
      .max(1000)
      .optional(),
  })
  .strict();

/**
 * POST /api/v1/requests/:id/review — the customer reviews their OWN
 * completed service. Everything is derived server-side: the customer from
 * the session, the technician from the ACCEPTED offer. Rules:
 *   400 invalid payload · 403 not a customer · 404 not your request ·
 *   409 not completed / no matched technician / already reviewed.
 * One review per service request (unique index is the hard backstop).
 * On success the technician's public rating is refreshed to the real
 * average of their actual reviews (trust-score input, §12/§21).
 */
app.post(
  "/api/v1/requests/:id/review",
  {
    preHandler: requireRole("customer"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_REVIEWS", 60) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const parsed = reviewCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const row = await loadRequestForUser(id, authUser); // throws 400/404 → error handler
    if (row.customer_user_id !== authUser.id) {
      // A participating technician never reviews their own job (404 like any stranger).
      return jsonResponse(reply, 404, { error: "Service request not found" });
    }
    if (row.status !== "completed") {
      return jsonResponse(reply, 409, {
        error: "Reviews can only be submitted for completed services",
      });
    }
    const accepted = await loadAcceptedTechnician(row.id);
    if (!accepted) {
      return jsonResponse(reply, 409, {
        error: "This service has no matched technician to review",
      });
    }
    const existing = await loadReviewForRequest(row.id);
    if (existing) {
      return jsonResponse(reply, 409, {
        error: "This service has already been reviewed",
      });
    }

    try {
      const created = await transaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO reviews (id, service_request_id, customer_id, technician_id, rating, comment, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           RETURNING id`,
          [
            crypto.randomUUID(),
            row.id,
            authUser.id,
            accepted.technician_id,
            parsed.data.rating,
            parsed.data.comment ?? null,
          ],
        );
        // Reputation: the public rating becomes the real average of the
        // technician's actual reviews (1 decimal). Nothing else changes.
        await client.query(
          `UPDATE technicians
           SET rating = (
                 SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE technician_id = $1
               ),
               updated_at = NOW()
           WHERE id = $1`,
          [accepted.technician_id],
        );
        return (inserted.rows as { id: string }[])[0].id;
      });
      const review = await loadReviewForRequest(row.id);
      return jsonResponse(reply, 201, { data: review ?? { id: created } });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        return jsonResponse(reply, 409, {
          error: "This service has already been reviewed",
        });
      }
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to submit the review" });
    }
  },
);

/**
 * GET /api/v1/technicians/:id/reviews — PUBLIC reputation bundle:
 * real aggregate (average rounded to 1 decimal, count, star distribution)
 * plus the newest-first review list with public-safe customer names.
 */
app.get("/api/v1/technicians/:id/reviews", async (request, reply) => {
  const { id } = request.params as { id: string };
  assertUuid(id);
  const technician = await query<{ id: string }>(
    "SELECT id FROM technicians WHERE id = $1",
    [id],
  );
  if (technician.length === 0) {
    return jsonResponse(reply, 404, { error: "Technician not found" });
  }
  try {
    const [summaryRows, reviewRows, distributionRows] = await Promise.all([
      query<{ average: string | null; count: number }>(
        `SELECT ROUND(AVG(rating)::numeric, 1) AS average, COUNT(*)::int AS count
         FROM reviews WHERE technician_id = $1`,
        [id],
      ),
      query<ReviewRow>(
        `SELECT r.id, r.rating, r.comment, r.created_at, u.first_name, u.last_name
         FROM reviews r
         JOIN users u ON u.id = r.customer_id
         WHERE r.technician_id = $1
         ORDER BY r.created_at DESC`,
        [id],
      ),
      query<{ rating: number; count: number }>(
        "SELECT rating, COUNT(*)::int AS count FROM reviews WHERE technician_id = $1 GROUP BY rating",
        [id],
      ),
    ]);
    const distribution = {
      "1": 0,
      "2": 0,
      "3": 0,
      "4": 0,
      "5": 0,
    } as TechnicianReviewsApi["summary"]["distribution"];
    for (const row of distributionRows) {
      if (row.rating >= 1 && row.rating <= 5) {
        distribution[String(row.rating) as keyof typeof distribution] =
          row.count;
      }
    }
    const payload: TechnicianReviewsApi = {
      technicianId: id,
      summary: {
        average:
          summaryRows[0].average === null
            ? null
            : Number(summaryRows[0].average),
        count: summaryRows[0].count,
        distribution,
      },
      reviews: reviewRows.map(toReviewApi),
    };
    return jsonResponse(reply, 200, { data: payload });
  } catch (error) {
    app.log.error(error);
    return jsonResponse(reply, 500, { error: "Failed to fetch reviews" });
  }
});

/* ----------------------------------------------------------------------- */
/* Task 28.2B — authenticated Web Push subscription API (/me/...)        */
/* ----------------------------------------------------------------------- */

/** Row shape for the safe subscription projection (no keys, no user id). */
interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
}

function toPushSubscriptionApi(row: PushSubscriptionRow): PushSubscriptionApi {
  return {
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Push endpoints live on third-party push services and must be HTTPS. */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

// Length caps mirror what real subscriptions carry (a p256dh key is 87
// chars base64url, an auth secret ~22) with generous headroom; the endpoint
// cap comfortably covers push-service URLs. userAgent is optional metadata.
const pushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .trim()
      .min(1, "A push endpoint is required")
      .max(2048, "The push endpoint is too long")
      .refine(isHttpsUrl, "The push endpoint must be a valid HTTPS URL"),
    p256dh: z
      .string()
      .trim()
      .min(1, "The p256dh key is required")
      .max(200, "The p256dh key is too long"),
    auth: z
      .string()
      .trim()
      .min(1, "The auth secret is required")
      .max(100, "The auth secret is too long"),
    userAgent: z
      .string()
      .trim()
      .max(500, "The user agent is too long")
      .optional(),
  })
  .strict();

/**
 * POST /api/v1/me/push-subscriptions — register (or refresh) the caller's
 * browser push subscription. Any authenticated role may subscribe; the
 * user_id always comes from the verified auth context, never the body
 * (the strict schema rejects user_id outright). (user_id, endpoint) is
 * unique: re-subscribing the same endpoint updates the keys/metadata
 * (200) instead of creating a second row; a new endpoint creates one (201).
 * A concurrent duplicate insert (23505) falls back to the update path, so
 * the response stays idempotent under races too.
 */
app.post(
  "/api/v1/me/push-subscriptions",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_PUSH_SUBSCRIPTIONS", 60) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    const parsed = pushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const userAgent =
      parsed.data.userAgent && parsed.data.userAgent.length > 0
        ? parsed.data.userAgent
        : null;
    try {
      const existing = await query<PushSubscriptionRow>(
        `SELECT id, endpoint, user_agent, created_at, updated_at
         FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
        [authUser.id, parsed.data.endpoint],
      );
      if (existing.length > 0) {
        const updated = await query<PushSubscriptionRow>(
          `UPDATE push_subscriptions
           SET p256dh = $1, auth = $2, user_agent = $3, updated_at = NOW()
           WHERE user_id = $4 AND endpoint = $5
           RETURNING id, endpoint, user_agent, created_at, updated_at`,
          [
            parsed.data.p256dh,
            parsed.data.auth,
            userAgent,
            authUser.id,
            parsed.data.endpoint,
          ],
        );
        return jsonResponse(reply, 200, {
          data: toPushSubscriptionApi(updated[0]),
        });
      }
      try {
        const created = await query<PushSubscriptionRow>(
          `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           RETURNING id, endpoint, user_agent, created_at, updated_at`,
          [
            crypto.randomUUID(),
            authUser.id,
            parsed.data.endpoint,
            parsed.data.p256dh,
            parsed.data.auth,
            userAgent,
          ],
        );
        return jsonResponse(reply, 201, {
          data: toPushSubscriptionApi(created[0]),
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        ) {
          // Lost a concurrent insert race — the row now exists, so take
          // the update path and stay idempotent.
          const updated = await query<PushSubscriptionRow>(
            `UPDATE push_subscriptions
             SET p256dh = $1, auth = $2, user_agent = $3, updated_at = NOW()
             WHERE user_id = $4 AND endpoint = $5
             RETURNING id, endpoint, user_agent, created_at, updated_at`,
            [
              parsed.data.p256dh,
              parsed.data.auth,
              userAgent,
              authUser.id,
              parsed.data.endpoint,
            ],
          );
          return jsonResponse(reply, 200, {
            data: toPushSubscriptionApi(updated[0]),
          });
        }
        throw error;
      }
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to save the push subscription",
      });
    }
  },
);

/**
 * DELETE /api/v1/me/push-subscriptions/:id — remove one of the caller's
 * own subscriptions (e.g. browser revoked permission). Strictly
 * owner-scoped: another user's id and unknown ids get the identical 404,
 * so subscription existence never leaks across accounts. No admin bypass.
 */
app.delete(
  "/api/v1/me/push-subscriptions/:id",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_PUSH_SUBSCRIPTIONS", 60) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    assertUuid(id); // throws 400 → error handler
    try {
      const deleted = await query<{ id: string }>(
        "DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id",
        [id, authUser.id],
      );
      if (deleted.length === 0) {
        return jsonResponse(reply, 404, {
          error: "Push subscription not found",
        });
      }
      return jsonResponse(reply, 200, { data: { deleted: true } });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to delete the push subscription",
      });
    }
  },
);

/* ----------------------------------------------------------------------- */
/* Task 26 — technician profile, photo, verification documents & lifecycle  */
/* ----------------------------------------------------------------------- */

/** Accepted upload types. Extension is derived from the DECLARED mime type
 *  (never from the client filename), so a renamed executable stays unsafe. */
const PHOTO_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const DOCUMENT_MIME_EXT: Record<string, string> = {
  ...PHOTO_MIME_EXT,
  "application/pdf": "pdf",
};
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};
const VERIFICATION_DOCUMENT_TYPES: readonly VerificationDocumentType[] = [
  "national_id",
  "certificate",
  "trade_qualification",
  "professional_licence",
  "business_registration",
  "training_certificate",
  "other",
];

interface OwnTechnicianRow {
  id: string;
  name: string;
  category: string;
  skills: string[];
  service_area: string;
  bio: string | null;
  photo_key: string | null;
  rating: number;
  jobs: number;
  availability: string;
  availability_status: string;
  account_status: string;
  verified: boolean;
  verification_status: string;
  verification_rejection_reason: string | null;
  verification_submitted_at: string | null;
  verification_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const OWN_TECHNICIAN_COLUMNS = `id, name, category, skills, service_area, bio, photo_key,
  rating, jobs, availability, availability_status, account_status, verified,
  verification_status, verification_rejection_reason, verification_submitted_at,
  verification_reviewed_at, created_at, updated_at`;

/** The technician profile bound to the authenticated account (null → 404). */
async function loadOwnTechnician(
  request: FastifyRequest,
): Promise<OwnTechnicianRow | null> {
  const authUser = request.authUser;
  if (!authUser) return null;
  const rows = await query<OwnTechnicianRow>(
    `SELECT ${OWN_TECHNICIAN_COLUMNS} FROM technicians WHERE user_id = $1`,
    [authUser.id],
  );
  return rows[0] ?? null;
}

interface DocumentRow {
  id: string;
  document_type: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  review_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
}

function toDocumentApi(row: DocumentRow): TechnicianDocumentApi {
  return {
    id: row.id,
    documentType: row.document_type as VerificationDocumentType, // DB CHECK constraint
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    status: row.status as VerificationDocumentStatus, // DB CHECK constraint
    reviewReason: row.review_reason,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
  };
}

const DOCUMENT_COLUMNS = `id, document_type, file_name, content_type, size_bytes,
  status, review_reason, reviewed_at, reviewed_by, created_at`;

async function listDocuments(
  technicianId: string,
): Promise<TechnicianDocumentApi[]> {
  const rows = await query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS}
     FROM technician_verification_documents WHERE technician_id = $1
     ORDER BY created_at ASC`,
    [technicianId],
  );
  return rows.map(toDocumentApi);
}

/**
 * Audit §5.C — derive the technician's OVERALL verification status from the
 * individual document review outcomes, then persist it (keeping the legacy
 * invariant verified ⟺ verification_status='verified'). Called after every
 * per-document decision so an upload alone can never confer trust.
 *
 * Policy:
 *   - no documents                                   → 'unverified'
 *   - identity (national_id) rejected                → 'rejected'
 *   - identity approved + every document approved    → 'verified'
 *   - identity approved + anything pending/rejected  → 'partially_verified'
 *   - identity missing/pending + something approved  → 'partially_verified'
 *   - otherwise (awaiting first review)              → 'pending'
 */
async function recomputeVerificationStatus(
  technicianId: string,
  reviewerId: string,
): Promise<{ status: TechnicianVerificationStatus; verified: boolean }> {
  const docs = await query<{
    document_type: string;
    status: string;
    review_reason: string | null;
  }>(
    `SELECT document_type, status, review_reason
     FROM technician_verification_documents WHERE technician_id = $1`,
    [technicianId],
  );

  let status: TechnicianVerificationStatus;
  let verified = false;
  let rejectionReason: string | null = null;

  if (docs.length === 0) {
    status = "unverified";
  } else {
    const identity = docs.find((d) => d.document_type === "national_id");
    const approved = docs.filter((d) => d.status === "approved").length;
    const pending = docs.filter((d) => d.status === "pending").length;
    const rejectedDocs = docs.filter((d) => d.status === "rejected");
    const firstReason =
      rejectedDocs[0]?.review_reason ??
      (identity?.status === "rejected" ? identity.review_reason : null);

    if (identity && identity.status === "rejected") {
      status = "rejected";
      rejectionReason = identity.review_reason;
    } else if (identity && identity.status === "approved") {
      if (rejectedDocs.length === 0 && pending === 0) {
        status = "verified";
        verified = true;
      } else {
        status = "partially_verified";
        rejectionReason = firstReason;
      }
    } else if (approved > 0) {
      status = "partially_verified";
      rejectionReason = firstReason;
    } else {
      status = "pending";
      rejectionReason = firstReason;
    }
  }

  await query(
    `UPDATE technicians
     SET verification_status = $1, verified = $2,
         verification_rejection_reason = $3,
         verification_reviewed_at = NOW(), verification_reviewed_by = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [status, verified, rejectionReason, reviewerId, technicianId],
  );
  return { status, verified };
}

function toOwnProfile(
  t: OwnTechnicianRow,
  documents: TechnicianDocumentApi[],
): TechnicianOwnProfileApi {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    skills: t.skills,
    serviceArea: t.service_area,
    bio: t.bio,
    hasPhoto: t.photo_key !== null,
    rating: t.rating,
    jobs: t.jobs,
    availability: t.availability,
    availabilityStatus: t.availability_status,
    accountStatus: t.account_status,
    verified: t.verified,
    verificationStatus:
      t.verification_status as TechnicianOwnProfileApi["verificationStatus"],
    verificationRejectionReason: t.verification_rejection_reason,
    verificationSubmittedAt: t.verification_submitted_at,
    verificationReviewedAt: t.verification_reviewed_at,
    documents,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/** First multipart file part plus a typed field reader (fields must be
 *  appended to the FormData BEFORE the file — busboy emits in order). */
function uploadField(
  part: { fields: Record<string, unknown> },
  name: string,
): string | undefined {
  const field = part.fields[name];
  if (Array.isArray(field) || typeof field !== "object" || field === null)
    return undefined;
  const value = (field as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

/** Display-only filename: basename, hostile characters stripped, bounded. */
function sanitizeFileName(raw: string | undefined): string {
  const base = path.basename(raw ?? "document");
  const cleaned = base.replace(/[^\w. ()-]/g, "_").trim();
  return cleaned.slice(0, 120) || "document";
}

/**
 * GET /api/v1/technicians/:id/photo — public profile photo bytes.
 * The photo is PUBLIC presentation data (unlike verification documents);
 * storage keys stay server-side, bytes stream through this endpoint only.
 */
app.get("/api/v1/technicians/:id/photo", async (request, reply) => {
  const { id } = request.params as { id: string };
  assertUuid(id); // throws 400 → error handler
  const rows = await query<{ photo_key: string | null }>(
    "SELECT photo_key FROM technicians WHERE id = $1",
    [id],
  );
  const key = rows[0]?.photo_key;
  if (!key) {
    return jsonResponse(reply, 404, { error: "Profile photo not found" });
  }
  const buffer = await getFileStorage().read(key);
  if (!buffer) {
    return jsonResponse(reply, 404, { error: "Profile photo not found" });
  }
  const ext = key.split(".").pop() ?? "";
  return reply
    .header("Cache-Control", "public, max-age=60")
    .type(EXT_MIME[ext] ?? "application/octet-stream")
    .send(buffer);
});

/**
 * GET /api/v1/technician/profile — the authenticated technician's own
 * profile, verification state, and document list. Technician role only.
 */
app.get(
  "/api/v1/technician/profile",
  { preHandler: requireRole("technician") },
  async (request, reply) => {
    const tech = await loadOwnTechnician(request);
    if (!tech) {
      return jsonResponse(reply, 404, {
        error: "Technician profile not found",
      });
    }
    const documents = await listDocuments(tech.id);
    return jsonResponse(reply, 200, { data: toOwnProfile(tech, documents) });
  },
);

const technicianProfilePatchSchema = z
  .object({
    bio: z
      .string()
      .trim()
      .min(1, "Bio cannot be empty")
      .max(500)
      .nullable()
      .optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    category: z
      .enum(CANONICAL_CATEGORIES as unknown as [string, ...string[]])
      .optional(),
    serviceArea: z.enum(["Kitwe", "Ndola"]).optional(),
    availability: z.string().trim().min(1).max(60).optional(),
    availabilityStatus: z.enum(["available", "unavailable"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

/**
 * PATCH /api/v1/technician/profile — owner-editable profile fields only
 * (bio, skills, category, serviceArea, availability text + status). The
 * display name stays account-derived (Task 23 identity — never duplicated).
 * A service-area change re-derives the deterministic city-centre
 * coordinates exactly like registration does.
 */
app.patch(
  "/api/v1/technician/profile",
  { preHandler: requireRole("technician") },
  async (request, reply) => {
    const tech = await loadOwnTechnician(request);
    if (!tech) {
      return jsonResponse(reply, 404, {
        error: "Technician profile not found",
      });
    }
    const parsed = technicianProfilePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const patch = parsed.data;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (patch.bio !== undefined) {
      sets.push(`bio = $${i++}`);
      params.push(patch.bio);
    }
    if (patch.skills !== undefined) {
      sets.push(`skills = $${i++}::jsonb`);
      params.push(JSON.stringify(patch.skills));
    }
    if (patch.category !== undefined) {
      sets.push(`category = $${i++}`);
      params.push(patch.category);
    }
    if (patch.availability !== undefined) {
      sets.push(`availability = $${i++}`);
      params.push(patch.availability);
    }
    if (patch.availabilityStatus !== undefined) {
      sets.push(`availability_status = $${i++}`);
      params.push(patch.availabilityStatus);
    }
    if (patch.serviceArea !== undefined) {
      const centre = CITY_CENTRES[patch.serviceArea];
      if (!centre) {
        return jsonResponse(reply, 400, {
          error: "A valid service area is required",
        });
      }
      sets.push(`service_area = $${i++}`);
      params.push(patch.serviceArea);
      sets.push(`latitude = $${i++}`);
      params.push(centre.latitude);
      sets.push(`longitude = $${i++}`);
      params.push(centre.longitude);
      sets.push(`location = ST_GeomFromText($${i++}, 4326)`);
      params.push(`POINT(${centre.longitude} ${centre.latitude})`);
    }
    sets.push("updated_at = NOW()");
    params.push(tech.id);
    try {
      await query(
        `UPDATE technicians SET ${sets.join(", ")} WHERE id = $${i}`,
        params,
      );
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to update profile" });
    }
    const fresh = await loadOwnTechnician(request);
    const documents = await listDocuments(tech.id);
    return jsonResponse(reply, 200, {
      data: toOwnProfile(fresh as OwnTechnicianRow, documents),
    });
  },
);

/**
 * POST /api/v1/technician/photo — upload/replace the profile photo.
 * Multipart, one image (JPEG/PNG/WebP), ≤ 5 MB. Replacing removes the
 * previous file from storage. Photo bytes are served publicly via
 * GET /technicians/:id/photo.
 */
app.post(
  "/api/v1/technician/photo",
  {
    preHandler: requireRole("technician"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_UPLOADS", 60) },
  },
  async (request, reply) => {
    const tech = await loadOwnTechnician(request);
    if (!tech) {
      return jsonResponse(reply, 404, {
        error: "Technician profile not found",
      });
    }
    const part = await request.file();
    if (!part) {
      return jsonResponse(reply, 400, { error: "No file uploaded" });
    }
    const ext = PHOTO_MIME_EXT[part.mimetype];
    if (!ext) {
      part.file.resume(); // drain before answering
      return jsonResponse(reply, 415, {
        error: "Unsupported image type. Use JPEG, PNG, or WebP.",
      });
    }
    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      return jsonResponse(reply, 413, {
        error: "File exceeds the 5 MB limit.",
      });
    }
    if (!buffer || buffer.length === 0) {
      return jsonResponse(reply, 400, { error: "The uploaded file is empty." });
    }
    // Task 28 §7 — magic-byte check: the declared Content-Type/extension is
    // not trusted on its own. Rejects executables/scripts and content whose
    // real signature does not match the declared image MIME.
    const magic = validateMagicBytes(buffer, part.mimetype);
    if (!magic.valid) {
      return jsonResponse(reply, 415, {
        error: magic.error ?? "File content does not match its declared type.",
      });
    }
    const key = `profiles/${tech.id}.${ext}`;
    try {
      await getFileStorage().put(key, buffer);
      const previousKey = tech.photo_key;
      await query(
        "UPDATE technicians SET photo_key = $1, updated_at = NOW() WHERE id = $2",
        [key, tech.id],
      );
      if (previousKey && previousKey !== key) {
        await getFileStorage().remove(previousKey);
      }
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to store the photo" });
    }
    return jsonResponse(reply, 201, { data: { hasPhoto: true } });
  },
);

/**
 * POST /api/v1/technician/verification/documents — submit one evidence
 * document (national_id | certificate | other; JPEG/PNG/WebP/PDF; ≤ 5 MB).
 * Allowed only while the verification is editable (unverified/rejected) —
 * never while a review is pending or after approval.
 */
app.post(
  "/api/v1/technician/verification/documents",
  {
    preHandler: requireRole("technician"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_UPLOADS", 60) },
  },
  async (request, reply) => {
    const tech = await loadOwnTechnician(request);
    if (!tech) {
      return jsonResponse(reply, 404, {
        error: "Technician profile not found",
      });
    }
    if (tech.verification_status === "pending") {
      return jsonResponse(reply, 409, {
        error: "Verification is already under review.",
      });
    }
    if (tech.verification_status === "verified") {
      return jsonResponse(reply, 409, {
        error: "This technician is already verified.",
      });
    }
    const part = await request.file();
    const documentType = part ? uploadField(part, "documentType") : undefined;
    if (
      !documentType ||
      !(VERIFICATION_DOCUMENT_TYPES as readonly string[]).includes(documentType)
    ) {
      part?.file.resume();
      return jsonResponse(reply, 400, {
        error:
          "A valid documentType is required (national_id, certificate, trade_qualification, professional_licence, business_registration, training_certificate, other).",
      });
    }
    if (!part) {
      return jsonResponse(reply, 400, { error: "No file uploaded" });
    }
    const ext = DOCUMENT_MIME_EXT[part.mimetype];
    if (!ext) {
      part.file.resume();
      return jsonResponse(reply, 415, {
        error: "Unsupported file type. Use JPEG, PNG, WebP, or PDF.",
      });
    }
    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      return jsonResponse(reply, 413, {
        error: "File exceeds the 5 MB limit.",
      });
    }
    if (!buffer || buffer.length === 0) {
      return jsonResponse(reply, 400, { error: "The uploaded file is empty." });
    }
    // Task 28 §7 — magic-byte check (JPEG/PNG/WebP/PDF); rejects executables,
    // scripts/markup, and content whose real signature does not match the
    // declared MIME. Verification documents stay private (never public).
    const magic = validateMagicBytes(buffer, part.mimetype);
    if (!magic.valid) {
      return jsonResponse(reply, 415, {
        error: magic.error ?? "File content does not match its declared type.",
      });
    }
    const id = crypto.randomUUID();
    const key = `verification/${tech.id}/${id}.${ext}`;
    try {
      await getFileStorage().put(key, buffer);
      const rows = await query<DocumentRow>(
        `INSERT INTO technician_verification_documents
           (id, technician_id, document_type, file_name, content_type, size_bytes, storage_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING ${DOCUMENT_COLUMNS}`,
        [
          id,
          tech.id,
          documentType,
          sanitizeFileName(part.filename),
          part.mimetype,
          buffer.length,
          key,
        ],
      );
      return jsonResponse(reply, 201, { data: toDocumentApi(rows[0]) });
    } catch (error) {
      await getFileStorage().remove(key); // never orphan a stored file
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to store the document",
      });
    }
  },
);

/**
 * DELETE /api/v1/technician/verification/documents/:id — withdraw one of
 * the owner's documents while the verification is still editable. Other
 * technicians' documents are hidden behind the same 404 as missing ones.
 */
app.delete(
  "/api/v1/technician/verification/documents/:id",
  { preHandler: requireRole("technician") },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    assertUuid(id);
    const tech = await loadOwnTechnician(request);
    if (!tech) {
      return jsonResponse(reply, 404, {
        error: "Technician profile not found",
      });
    }
    if (tech.verification_status === "pending") {
      return jsonResponse(reply, 409, {
        error: "Verification is already under review.",
      });
    }
    if (tech.verification_status === "verified") {
      return jsonResponse(reply, 409, {
        error: "This technician is already verified.",
      });
    }
    const rows = await query<{ id: string; storage_key: string }>(
      "SELECT id, storage_key FROM technician_verification_documents WHERE id = $1 AND technician_id = $2",
      [id, tech.id],
    );
    if (rows.length === 0) {
      return jsonResponse(reply, 404, { error: "Document not found" });
    }
    await query("DELETE FROM technician_verification_documents WHERE id = $1", [
      id,
    ]);
    await getFileStorage().remove(rows[0].storage_key);
    // Task 28.3F: record the withdrawal of identity evidence. Only the opaque
    // document id is recorded — not the filename, type, bytes or storage key.
    await recordAuditEvent({
      eventType: "security.verification_document_deleted",
      actorUserId: request.authUser?.id ?? null,
      actorRole: request.authUser?.role ?? null,
      targetUserId: request.authUser?.id ?? null,
      targetEntityType: "verification_document",
      targetEntityId: id,
      metadata: {
        route: "/api/v1/technician/verification/documents/:id",
        scope: "owner",
      },
    });
    return jsonResponse(reply, 200, { data: { deleted: true } });
  },
);

/**
 * POST /api/v1/technician/verification/submit — the only path into
 * 'pending' (unverified → pending, rejected → pending after correction).
 * Requires at least one national_id document; rejected state clears its
 * review metadata so the administrator sees a fresh submission.
 */
app.post(
  "/api/v1/technician/verification/submit",
  {
    preHandler: requireRole("technician"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_VERIFICATION", 20) },
  },
  async (request, reply) => {
    const tech = await loadOwnTechnician(request);
    if (!tech) {
      return jsonResponse(reply, 404, {
        error: "Technician profile not found",
      });
    }
    if (tech.verification_status === "pending") {
      return jsonResponse(reply, 409, {
        error: "Verification is already under review.",
      });
    }
    if (tech.verification_status === "verified") {
      return jsonResponse(reply, 409, {
        error: "This technician is already verified.",
      });
    }
    const nationalIds = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM technician_verification_documents
       WHERE technician_id = $1 AND document_type = 'national_id'`,
      [tech.id],
    );
    if (Number(nationalIds[0].n) === 0) {
      return jsonResponse(reply, 400, {
        error:
          "A National ID document is required before submitting for verification.",
      });
    }
    try {
      await query(
        `UPDATE technicians
         SET verification_status = 'pending', verification_submitted_at = NOW(),
             verification_rejection_reason = NULL, verification_reviewed_at = NULL,
             verification_reviewed_by = NULL, updated_at = NOW()
         WHERE id = $1`,
        [tech.id],
      );
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to submit verification",
      });
    }
    // Task 28.2D5 — verification-submitted fan-out: every active
    // administrator gets their own notification (DB-authoritative set, never
    // hard-coded). Zero admins is a no-op — submission still succeeds.
    // Failures are logged per admin without failing the submission.
    try {
      const admins = await query<{ id: string }>(
        `SELECT id FROM users WHERE role = 'administrator' AND account_status = 'active'`,
      );
      for (const admin of admins) {
        await recordAndDeliverEvent(
          {
            userId: admin.id,
            type: "technician_verification_submitted",
            title: "New verification submission",
            message: `${tech.name} submitted verification for review.`,
            referenceType: "technician",
            referenceId: tech.id,
            channel: "in_app",
          },
          (error) => app.log.error(error),
        );
      }
    } catch (error) {
      app.log.error(error);
    }
    return jsonResponse(reply, 200, {
      data: { verificationStatus: "pending" },
    });
  },
);

/**
 * GET /api/v1/verification-documents/:id/file — the ONLY way document
 * bytes leave storage. Administrator (review) or the owning technician —
 * everyone else gets the same 404 as a missing document (no IDOR leak).
 */
app.get(
  "/api/v1/verification-documents/:id/file",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    assertUuid(id);
    const rows = await query<{
      storage_key: string;
      content_type: string;
      file_name: string;
      owner_user_id: string | null;
    }>(
      `SELECT d.storage_key, d.content_type, d.file_name, t.user_id AS owner_user_id
       FROM technician_verification_documents d
       JOIN technicians t ON t.id = d.technician_id
       WHERE d.id = $1`,
      [id],
    );
    const doc = rows[0];
    if (
      !doc ||
      (authUser.role !== "administrator" && doc.owner_user_id !== authUser.id)
    ) {
      return jsonResponse(reply, 404, { error: "Document not found" });
    }
    const buffer = await getFileStorage().read(doc.storage_key);
    if (!buffer) {
      return jsonResponse(reply, 404, { error: "Document not found" });
    }
    // Task 28.3F: reading identity evidence is a security-relevant access.
    // Only opaque ids and the document TYPE are recorded — never the bytes,
    // never the filename, never the storage key.
    await recordAuditEvent({
      eventType: "security.verification_document_accessed",
      actorUserId: authUser.id,
      actorRole: authUser.role,
      targetUserId: doc.owner_user_id,
      targetEntityType: "verification_document",
      targetEntityId: id,
      metadata: {
        route: "/api/v1/verification-documents/:id/file",
        // An administrator reading a technician's evidence, versus the
        // technician reading their own, is a meaningful distinction.
        scope: authUser.role === "administrator" ? "reviewer" : "owner",
      },
    });
    // Task 28.3G hardening: identity documents must never be written to a
    // shared or on-disk cache by an intermediary or the browser.
    const safeFileName = doc.file_name.replace(/["\\\r\n/]/g, "").slice(0, 120);
    return reply
      .header(
        "Content-Disposition",
        `inline; filename="${safeFileName || "document"}"`,
      )
      .header("Cache-Control", "no-store, no-cache, must-revalidate, private")
      .header("Pragma", "no-cache")
      .type(doc.content_type)
      .send(buffer);
  },
);

interface AdminVerificationRow {
  id: string;
  name: string;
  category: string;
  skills: string[];
  service_area: string;
  bio: string | null;
  photo_key: string | null;
  rating: number;
  jobs: number;
  availability: string;
  availability_status: string;
  account_status: string;
  verified: boolean;
  verification_status: string;
  verification_rejection_reason: string | null;
  verification_submitted_at: string | null;
  verification_reviewed_at: string | null;
  verification_reviewed_by: string | null;
  user_id: string | null;
  user_email: string | null;
  reviewer_email: string | null;
  created_at: string;
  updated_at: string;
}

async function loadAdminVerification(
  technicianId: string,
): Promise<AdminTechnicianVerificationApi | null> {
  const rows = await query<AdminVerificationRow>(
    `SELECT t.id, t.name, t.category, t.skills, t.service_area, t.bio, t.photo_key,
            t.rating, t.jobs, t.availability, t.availability_status, t.account_status,
            t.verified, t.verification_status, t.verification_rejection_reason,
            t.verification_submitted_at, t.verification_reviewed_at,
            t.verification_reviewed_by, t.created_at, t.updated_at,
            u.id AS user_id, u.email AS user_email, reviewer.email AS reviewer_email
     FROM technicians t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN users reviewer ON reviewer.id = t.verification_reviewed_by
     WHERE t.id = $1`,
    [technicianId],
  );
  const t = rows[0];
  if (!t) return null;
  const documents = await listDocuments(technicianId);
  const reviewRows = await query<{
    id: string;
    document_id: string;
    decision: string;
    reason: string | null;
    reviewer_email: string | null;
    created_at: string;
  }>(
    `SELECT r.id, r.document_id, r.decision, r.reason,
            reviewer.email AS reviewer_email, r.created_at
     FROM verification_reviews r
     LEFT JOIN users reviewer ON reviewer.id = r.reviewer_id
     WHERE r.technician_id = $1
     ORDER BY r.created_at DESC`,
    [technicianId],
  );
  const reviews: VerificationReviewApi[] = reviewRows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    decision: r.decision as "approved" | "rejected",
    reason: r.reason,
    reviewerEmail: r.reviewer_email,
    createdAt: r.created_at,
  }));
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    skills: t.skills,
    serviceArea: t.service_area,
    bio: t.bio,
    hasPhoto: t.photo_key !== null,
    rating: t.rating,
    jobs: t.jobs,
    availability: t.availability,
    availabilityStatus: t.availability_status,
    accountStatus: t.account_status,
    verified: t.verified,
    verificationStatus:
      t.verification_status as AdminTechnicianVerificationApi["verificationStatus"],
    verificationRejectionReason: t.verification_rejection_reason,
    verificationSubmittedAt: t.verification_submitted_at,
    verificationReviewedAt: t.verification_reviewed_at,
    verificationReviewedBy: t.verification_reviewed_by,
    verificationReviewerEmail: t.reviewer_email,
    userId: t.user_id,
    userEmail: t.user_email,
    documents,
    reviews,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

/**
 * GET /api/v1/admin/technicians/:id/verification — the administrator's
 * review bundle: profile, lifecycle state with rejection/reviewer
 * metadata, linked account, and the submitted document list.
 */
app.get(
  "/api/v1/admin/technicians/:id/verification",
  { preHandler: requireRole("administrator") },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    assertUuid(id);
    const bundle = await loadAdminVerification(id);
    if (!bundle) {
      return jsonResponse(reply, 404, { error: "Technician not found" });
    }
    return jsonResponse(reply, 200, { data: bundle });
  },
);

const verificationDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("verified") }),
  z.object({
    decision: z.literal("rejected"),
    reason: z
      .string()
      .trim()
      .min(
        8,
        "Give the technician a clear correction reason (min 8 characters)",
      )
      .max(500),
  }),
]);

/**
 * PATCH /api/v1/admin/technicians/:id/verification — the administrator
 * decision. Only a PENDING verification can be reviewed (409 otherwise):
 *   verified → verification_status='verified', verified=true, reviewer stamped
 *   rejected → verification_status='rejected', verified=false, reason REQUIRED
 * Availability is deliberately untouched — verification never forces it (§9).
 */
app.patch(
  "/api/v1/admin/technicians/:id/verification",
  {
    preHandler: requireRole("administrator"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ADMIN", 60) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    assertUuid(id);
    const parsed = verificationDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const current = await query<{ verification_status: string }>(
      "SELECT verification_status FROM technicians WHERE id = $1",
      [id],
    );
    if (current.length === 0) {
      return jsonResponse(reply, 404, { error: "Technician not found" });
    }
    if (current[0].verification_status !== "pending") {
      return jsonResponse(reply, 409, {
        error: "Only a pending verification can be reviewed.",
      });
    }
    const decision = parsed.data;
    try {
      if (decision.decision === "verified") {
        await query(
          `UPDATE technicians
           SET verification_status = 'verified', verified = true,
               verification_reviewed_at = NOW(), verification_reviewed_by = $1,
               verification_rejection_reason = NULL, updated_at = NOW()
           WHERE id = $2`,
          [authUser.id, id],
        );
      } else {
        await query(
          `UPDATE technicians
           SET verification_status = 'rejected', verified = false,
               verification_reviewed_at = NOW(), verification_reviewed_by = $1,
               verification_rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [authUser.id, decision.reason, id],
        );
      }
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to record the verification decision",
      });
    }
    const bundle = await loadAdminVerification(id);
    // Task 28.3F: record the privileged verification decision. The
    // administrator-authored rejection REASON is deliberately NOT copied into
    // the audit row — it is free text that can quote document content, and
    // the audit log is a security record, not a second copy of that text.
    await recordAuditEvent({
      eventType: "admin.verification_decision",
      actorUserId: authUser.id,
      actorRole: authUser.role,
      targetUserId: bundle?.userId ?? null,
      targetEntityType: "technician",
      targetEntityId: id,
      metadata: {
        decision: decision.decision,
        previous_status: current[0].verification_status,
        new_status: decision.decision === "verified" ? "verified" : "rejected",
        route: "/api/v1/admin/technicians/:id/verification",
      },
    });
    // Task 28.2D5 — verification decision notification to the affected
    // technician (linked account only; NULL safely skips). The rejection
    // reason is the admin-authored correction feedback, nothing else.
    // A notification failure is logged but never fails the recorded decision.
    if (bundle?.userId) {
      const decided =
        decision.decision === "verified"
          ? {
              type: "technician_verification_approved",
              title: "Verification approved",
              message: "Your technician verification was approved.",
            }
          : {
              type: "technician_verification_rejected",
              title: "Verification rejected",
              message: `Your technician verification was rejected: ${decision.reason}`,
            };
      await recordAndDeliverEvent(
        {
          userId: bundle.userId,
          type: decided.type,
          title: decided.title,
          message: decided.message,
          referenceType: "technician",
          referenceId: id,
          channel: "in_app",
        },
        (error) => app.log.error(error),
      );
    }
    return jsonResponse(reply, 200, { data: bundle });
  },
);

/** Human-readable document category labels (notifications/UI only). */
const DOCUMENT_TYPE_LABELS: Record<VerificationDocumentType, string> = {
  national_id: "National ID",
  certificate: "Certificate",
  trade_qualification: "Trade qualification",
  professional_licence: "Professional licence",
  business_registration: "Business registration",
  training_certificate: "Training certificate",
  other: "Supporting document",
};

const documentDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved") }),
  z.object({
    decision: z.literal("rejected"),
    reason: z
      .string()
      .trim()
      .min(
        8,
        "Give the technician a clear correction reason (min 8 characters)",
      )
      .max(500),
  }),
]);

/**
 * PATCH /api/v1/admin/technicians/:id/verification/documents/:docId
 * Audit §5.C — approve or reject ONE evidence document. Records the
 * decision on the document, appends an immutable row to verification_reviews,
 * then RE-DERIVES the technician's overall verification status from every
 * document's outcome (recomputeVerificationStatus). This is the mechanism
 * that makes verification evidence-based: the overall status is a function
 * of individual reviews, never of upload.
 *
 * The document must belong to the technician in the path (owner-scoped join,
 * uniform 404 otherwise — no IDOR leak). Availability is never touched.
 */
app.patch(
  "/api/v1/admin/technicians/:id/verification/documents/:docId",
  {
    preHandler: requireRole("administrator"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ADMIN", 60) },
  },
  async (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string };
    const authUser = request.authUser;
    if (!authUser) {
      return jsonResponse(reply, 401, { error: "Authentication required" });
    }
    assertUuid(id);
    assertUuid(docId);
    const parsed = documentDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const docRows = await query<{
      id: string;
      document_type: string;
      status: string;
    }>(
      `SELECT id, document_type, status
       FROM technician_verification_documents
       WHERE id = $1 AND technician_id = $2`,
      [docId, id],
    );
    const doc = docRows[0];
    if (!doc) {
      return jsonResponse(reply, 404, { error: "Document not found" });
    }
    const decision = parsed.data;
    const approved = decision.decision === "approved";
    const reason = approved ? null : decision.reason;
    try {
      await query(
        `UPDATE technician_verification_documents
         SET status = $1, reviewed_by = $2, review_reason = $3, reviewed_at = NOW()
         WHERE id = $4`,
        [approved ? "approved" : "rejected", authUser.id, reason, docId],
      );
      await query(
        `INSERT INTO verification_reviews
           (document_id, technician_id, reviewer_id, decision, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          docId,
          id,
          authUser.id,
          approved ? "approved" : "rejected",
          reason,
        ],
      );
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to record the document decision",
      });
    }
    const derived = await recomputeVerificationStatus(id, authUser.id);
    const bundle = await loadAdminVerification(id);
    // Privileged per-document decision. As with the whole-profile decision,
    // the admin-authored rejection REASON is deliberately NOT copied into the
    // audit row (free text may quote document content); only opaque ids and
    // the derived status are recorded.
    await recordAuditEvent({
      eventType: "admin.verification_document_decision",
      actorUserId: authUser.id,
      actorRole: authUser.role,
      targetUserId: bundle?.userId ?? null,
      targetEntityType: "verification_document",
      targetEntityId: docId,
      metadata: {
        decision: decision.decision,
        document_type: doc.document_type,
        previous_status: doc.status,
        derived_verification_status: derived.status,
        route: "/api/v1/admin/technicians/:id/verification/documents/:docId",
      },
    });
    // Notify the affected technician (linked account only; NULL safely skips).
    // A notification failure is logged but never fails the recorded decision.
    if (bundle?.userId) {
      const label =
        DOCUMENT_TYPE_LABELS[doc.document_type as VerificationDocumentType] ??
        "document";
      const decided = approved
        ? {
            type: "technician_verification_approved",
            title: "Document approved",
            message: `Your ${label} was approved.`,
          }
        : {
            type: "technician_verification_rejected",
            title: "Document rejected",
            message: `Your ${label} was rejected: ${decision.reason}`,
          };
      await recordAndDeliverEvent(
        {
          userId: bundle.userId,
          type: decided.type,
          title: decided.title,
          message: decided.message,
          referenceType: "technician",
          referenceId: id,
          channel: "in_app",
        },
        (error) => app.log.error(error),
      );
    }
    return jsonResponse(reply, 200, { data: bundle });
  },
);

/* ================================================================== */
/* Task 28.3 — data-subject privacy routes (28.3C / 28.3D) and the      */
/* notification inbox (28.3C, closing gap G-02).                      */
/*                                                                    */
/* Every route below derives its subject from `request.authUser`, which */
/* requireAuth populates by re-reading the row from PostgreSQL. There  */
/* is no client-supplied user id, recipient or owner anywhere.        */
/* ================================================================== */

/**
 * GET /api/v1/me/data — the authenticated account's own data (28.3C).
 *
 * Access, not a "download". Returns a real JSON export assembled from
 * authoritative database relationships. Password material, refresh-token
 * hashes, verification-document bytes/keys and push device keys are excluded
 * by construction (the projections in accountDataService never select them).
 * An audit event records that the export happened, without recording its
 * contents.
 */
app.get(
  "/api/v1/me/data",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 10) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      const exportPayload = await buildAccountExport(authUser.id);
      await recordAuditEvent({
        eventType: "privacy.data_exported",
        actorUserId: authUser.id,
        actorRole: authUser.role,
        targetUserId: authUser.id,
        targetEntityType: "user",
        targetEntityId: authUser.id,
        metadata: {
          export_format: exportPayload.format,
          record_count:
            exportPayload.counts.serviceRequests +
            exportPayload.counts.notifications +
            exportPayload.counts.reviewsWritten +
            exportPayload.counts.reviewsReceived,
          route: "/api/v1/me/data",
        },
      });
      return jsonResponse(reply, 200, { data: exportPayload });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to build your data export",
      });
    }
  },
);

/**
 * GET /api/v1/me/account/deletion-preview — what permanent deletion would
 * remove (28.3D). Read-only: it removes nothing. Exists so the confirmation
 * screen can state real counts instead of a generic warning.
 */
app.get(
  "/api/v1/me/account/deletion-preview",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 10) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      const counts = await previewAccountDeletion(authUser.id);
      return jsonResponse(reply, 200, {
        data: {
          counts,
          retainedAfterDeletion: {
            securityEvents:
              "Security/audit events are retained in minimised form (opaque ids, no personal data) so accountability survives an account deletion.",
            reviewRecipients:
              "Reviews other customers wrote about a deleted technician profile are removed with that profile, because a review cannot exist without a subject.",
          },
          warning:
            "Deletion is permanent and cannot be undone. It removes your account, technician profile, requests, offers, reviews, notifications, sessions, push subscriptions and verification documents.",
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to build the deletion preview",
      });
    }
  },
);

const accountDeletionSchema = z.object({
  /**
   * Re-authentication. Permanent deletion of an identity must never be a
   * single unauthenticated click, and must not be triggerable from a stolen
   * live session alone — the caller must prove they know the password.
   */
  password: z.string().min(1).max(200),
  /**
   * Explicit acknowledgement. The server does not trust a hidden flag alone;
   * this literal forces the UI to state the consequence.
   */
  confirm: z.literal("DELETE MY ACCOUNT"),
});

/**
 * DELETE /api/v1/me/account — permanent account deletion (28.3D).
 *
 * Requires (a) a valid session, and (b) the account password, so a borrowed
 * or unattended unlocked device is not enough on its own. There is no
 * client-supplied user id: the subject is always the authenticated principal.
 *
 * Deletion never fails the caller because of an audit or notification
 * problem — auditing is best-effort and logged separately.
 */
app.delete(
  "/api/v1/me/account",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ACCOUNT_DELETION", 5) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });

    const parsed = accountDeletionSchema.safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }

    // Re-authenticate against the stored hash before destroying anything.
    const rows = await query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [authUser.id],
    );
    const stored = rows[0];
    if (!stored) {
      // Already gone: report the same outcome as success without inventing
      // a second deletion, but do not pretend a body was removed.
      return jsonResponse(reply, 200, {
        data: { deleted: true, alreadyDeleted: true, report: null },
      });
    }
    const passwordOk = await verifyPassword(
      stored.password_hash,
      parsed.data.password,
    );
    if (!passwordOk) {
      await recordAuditEvent({
        eventType: "privacy.account_deleted",
        outcome: "denied",
        actorUserId: authUser.id,
        actorRole: authUser.role,
        targetUserId: authUser.id,
        targetEntityType: "user",
        targetEntityId: authUser.id,
        metadata: {
          reason_code: "password_mismatch",
          route: "/api/v1/me/account",
        },
      });
      return jsonResponse(reply, 401, {
        error: "Password confirmation failed",
      });
    }

    try {
      const report = await permanentlyDeleteAccount(authUser.id);
      // Recorded AFTER the account row is gone — audit_events has no FK to
      // users precisely so this can survive the deletion.
      await recordAuditEvent({
        eventType: "privacy.account_deleted",
        actorUserId: authUser.id,
        actorRole: authUser.role,
        targetUserId: authUser.id,
        targetEntityType: "user",
        targetEntityId: authUser.id,
        metadata: {
          deletion_scope: "full",
          record_count:
            report.serviceRequestsDeleted +
            report.offersDeleted +
            report.reviewsDeleted +
            report.notificationsDeleted +
            report.pushSubscriptionsDeleted +
            report.sessionsDeleted +
            report.verificationDocumentsDeleted,
          storage_objects: report.storageObjectsDeleted,
        },
      });
      return jsonResponse(reply, 200, {
        data: { deleted: true, alreadyDeleted: false, report },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to delete the account",
      });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Notification inbox (28.3C) — closes gap G-02                      */
/*                                                                     */
/* This reuses the EXISTING `notifications` table and NotificationService */
/* read methods. It adds no second notification store and changes no    */
/* push/SMS delivery semantics.                                        */
/* ------------------------------------------------------------------ */

const notificationListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * GET /api/v1/me/notifications — the caller's own notification history.
 *
 * Recipient comes from the session only. Pagination is explicit so the
 * payload stays small (low-data requirement). An account with no
 * notifications gets an honest empty list, not placeholder rows.
 */
app.get(
  "/api/v1/me/notifications",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 60) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    const parsed = notificationListSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    try {
      const { limit, offset } = parsed.data;
      const result = await NotificationService.getUserNotifications(
        authUser.id,
        limit,
        offset,
      );
      return jsonResponse(reply, 200, {
        data: {
          notifications: result.notifications,
          unreadCount: result.unreadCount,
          totalCount: result.totalCount,
          limit,
          offset,
          hasMore: offset + result.notifications.length < result.totalCount,
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to load notifications",
      });
    }
  },
);

/**
 * PATCH /api/v1/me/notifications/:id/read — mark one of the caller's own
 * notifications read. Owner-scoped in SQL (id AND user_id), so another
 * account's id simply updates nothing and yields the same 404.
 */
app.patch(
  "/api/v1/me/notifications/:id/read",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 120) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(id);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    try {
      const updated = await NotificationService.markAsRead(id, authUser.id);
      if (!updated)
        return jsonResponse(reply, 404, { error: "Notification not found" });
      return jsonResponse(reply, 200, { data: { id, read: true } });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to update the notification",
      });
    }
  },
);

/**
 * POST /api/v1/me/notifications/read-all — mark every unread notification
 * for the caller read. Returns the real number changed, so the UI can state
 * an honest "0 updated" when there was nothing to do.
 */
app.post(
  "/api/v1/me/notifications/read-all",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 60) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      const updated = await NotificationService.markAllAsRead(authUser.id);
      return jsonResponse(reply, 200, { data: { updated } });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to update notifications",
      });
    }
  },
);

/**
 * GET /api/v1/admin/audit-events — administrator-only audit read (28.3F).
 *
 * Restricted to administrators because the log describes privileged
 * activity across all accounts. Ordinary users reach their own security
 * history through GET /api/v1/me/data instead, and only for themselves.
 */
app.get(
  "/api/v1/admin/audit-events",
  {
    preHandler: requireRole("administrator"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ADMIN_READS", 60) },
  },
  async (request, reply) => {
    const queryParams = (request.query ?? {}) as Record<string, unknown>;
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional().default(50),
        offset: z.coerce.number().int().min(0).optional().default(0),
        eventType: z.enum(AUDIT_EVENT_TYPES).optional(),
        outcome: z.enum(["success", "failure", "denied"]).optional(),
        actorUserId: z.string().uuid().optional(),
      })
      .safeParse(queryParams);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    try {
      const { limit, offset, eventType, outcome, actorUserId } = parsed.data;
      const result = await listAuditEvents({
        limit,
        offset,
        eventType,
        outcome,
        actorUserId,
      });
      return jsonResponse(reply, 200, {
        data: {
          events: result.events,
          total: result.total,
          limit,
          offset,
          hasMore: offset + result.events.length < result.total,
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to load audit events" });
    }
  },
);

/**
 * GET /health — liveness: confirms the application process is up and serving.
 * Task 28 §17: health does NOT claim infrastructure it has not checked (the
 * previous hardcoded `database: 'connected'` was misleading); database
 * connectivity is asserted by GET /ready below.
 */
app.get("/health", async (_, reply) => {
  return jsonResponse(reply, 200, {
    data: {
      status: "ok",
      service: "umodzi-connect-api",
      version: "0.2.0",
    },
  });
});

/**
 * GET /ready — readiness: confirms required infrastructure (database) is
 * reachable before traffic is routed. 200 when a live query succeeds, 503
 * otherwise. Exposes no infrastructure details on failure.
 */
app.get("/ready", async (_, reply) => {
  try {
    await query("SELECT 1");
    return jsonResponse(reply, 200, { data: { status: "ready" } });
  } catch (error) {
    app.log.error(error);
    return jsonResponse(reply, 503, { error: "Service unavailable" });
  }
});

/* ================================================================== */
/* Task 28.4B — Communication routes (conversations, messages, phone)  */
/* ================================================================== */

/**
 * 
/**
 * Normalize a Zambia-facing number to a `tel:`-safe form.
 *
 * Rules, deliberately narrow:
 *   - strip separators and spaces;
 *   - accept a leading `+` (kept), or a national trunk `0` (replaced by the
 *     country code, so 0971 -> +260971);
 *   - require 9-15 digits after the country code, per ITU-T E.164;
 *   - return null for anything else, so an unusable number is never stored
 *     and never offered through /requests/:id/contact.
 */
function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s()\-.]/g, "");
  if (cleaned.length === 0) return null;
  const digitsOnly = cleaned.replace(/\D/g, "");
  let candidate: string;
  if (cleaned.startsWith("+")) {
    candidate = `+${digitsOnly}`;
  } else if (cleaned.startsWith("0")) {
    candidate = `+260${digitsOnly.replace(/^0+/, "")}`;
  } else if (digitsOnly.length === 9) {
    candidate = `+260${digitsOnly}`;
  } else {
    candidate = `+${digitsOnly}`;
  }
  return /^\+\d{9,15}$/.test(candidate) ? candidate : null;
}

/**
 * GET /api/v1/me/phone - the authenticated user's own stored number.
 * Returns `phone: null` when none exists (honest, never a placeholder).
 */
app.get(
  "/api/v1/me/phone",
  { preHandler: requireAuth },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      const rows = await query<{ phone_normalized: string }>(
        `SELECT phone_normalized FROM user_phones
        WHERE user_id = $1 AND purpose = 'service_contact'
        ORDER BY updated_at DESC LIMIT 1`,
        [authUser.id],
      );
      return jsonResponse(reply, 200, {
        data: { phone: rows[0]?.phone_normalized ?? null },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to load phone number" });
    }
  },
);

/**
 * PUT /api/v1/me/phone - set or replace the authenticated user's own number.
 *
 * Strict schema: any extra field is rejected. The number is normalized and
 * length-checked server-side, so an invalid value is never persisted. An
 * existing number is replaced, not silently ignored - the user must be able
 * to correct it.
 */
app.put(
  "/api/v1/me/phone",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 30) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    const parsed = z
      .object({
        phone: z.string().trim().min(6, "Enter a phone number").max(20),
        purpose: z
          .enum(["service_contact"])
          .optional()
          .default("service_contact"),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }
    const normalized = normalizePhone(parsed.data.phone);
    if (!normalized) {
      return jsonResponse(reply, 400, {
        error:
          "Enter a valid phone number, for example 0971 234 567 or +260971234567.",
      });
    }
    try {
      // Replace any existing row for this purpose: one authoritative number.
      await query(
        `DELETE FROM user_phones WHERE user_id = $1 AND purpose = $2`,
        [authUser.id, parsed.data.purpose],
      );
      const rows = await query<{ phone_normalized: string }>(
        `INSERT INTO user_phones (id, user_id, phone_normalized, phone_raw, country_code, purpose)
         VALUES ($1, $2, $3, $4, '+260', $5)
         RETURNING phone_normalized`,
        [
          crypto.randomUUID(),
          authUser.id,
          normalized,
          parsed.data.phone.trim(),
          parsed.data.purpose,
        ],
      );
      return jsonResponse(reply, 200, {
        data: { phone: rows[0]?.phone_normalized ?? normalized },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to save phone number" });
    }
  },
);

/**
 * GET /api/v1/conversations/:id — conversation detail keyed by CONVERSATION id.
 *
 * The request-scoped route above covers links that carry a service request id
 * (the conversation list). Notification deep links carry the conversation id
 * instead, so this endpoint resolves the same payload from that id. Same
 * authorization (`canAccessConversation`), same response shape, same honest
 * 404 — there is no second authorization model here, only a second key.
 */
app.get(
  "/api/v1/conversations/:id",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { id: conversationId } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(conversationId);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    try {
      const access = await canAccessConversation(request, conversationId);
      if (!access.exists || !access.allowed) {
        // Missing, foreign, or closed: one indistinguishable answer.
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }

      const rows = await query<{
        id: string;
        service_request_id: string;
        customer_id: string;
        technician_id: string;
        status: string;
        created_at: string;
        updated_at: string;
        is_customer: boolean;
        other_user_id: string | null;
        other_display_name: string | null;
        request_city: string | null;
        request_category: string | null;
        has_accepted_offer: boolean;
      }>(
        `SELECT c.id, c.service_request_id, c.customer_id, c.technician_id, c.status,
                c.created_at, c.updated_at,
                ($2 = c.customer_id) AS is_customer,
                CASE WHEN $2 = c.customer_id THEN
                     (SELECT tu.id FROM users tu JOIN technicians t2 ON t2.user_id = tu.id WHERE t2.id = c.technician_id LIMIT 1)
                ELSE c.customer_id END AS other_user_id,
                COALESCE(
                  CASE WHEN $2 = c.customer_id THEN
                    (SELECT t3.name FROM technicians t3 WHERE t3.id = c.technician_id LIMIT 1)
                  ELSE (SELECT (u2.first_name || ' ' || u2.last_name) FROM users u2 WHERE u2.id = c.customer_id LIMIT 1)
                END, '') AS other_display_name,
                r.city AS request_city,
                r.category AS request_category,
                EXISTS (SELECT 1 FROM dispatch_offers o WHERE o.request_id = c.service_request_id AND o.status = 'accepted') AS has_accepted_offer
           FROM conversations c
           JOIN service_requests r ON r.id = c.service_request_id
          WHERE c.id = $1
          LIMIT 1`,
        [conversationId, authUser.id],
      );
      const row = rows[0];
      if (!row) {
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }
      return jsonResponse(reply, 200, {
        data: {
          conversation: {
            id: row.id,
            serviceRequestId: row.service_request_id,
            customerId: row.customer_id,
            technicianId: row.technician_id,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          otherParticipant: {
            userId: row.other_user_id,
            displayName: row.other_display_name || "Participant",
            // If the caller is the customer, the other participant is the
            // technician (and vice versa) — so these read across deliberately.
            isTechnician: row.is_customer,
            isCustomer: !row.is_customer,
          },
          request: {
            id: row.service_request_id,
            city: row.request_city,
            category: row.request_category,
          },
          canCommunicate: row.status === "active" && row.has_accepted_offer,
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to load conversation" });
    }
  },
);

/**
 * GET /api/v1/requests/:id/conversation — the conversation for an authorized
 * participant on one service request.
 *
 * 404 when the request never reached an ACCEPTED offer, so no conversation
 * exists (honest absence, not a hidden one). 403 when the requester is not a
 * participant at all. The participant identity is always derived from the
 * session and the database — never from the client.
 */
app.get(
  "/api/v1/requests/:id/conversation",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { id: requestId } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(requestId);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    try {
      const authResult = await canCommunicateOnRequest(request, requestId, {
        // The thread remains readable after completion/cancellation; only the
        // contact-number route keeps the tighter active-service window.
        includeClosedHistory: true,
      });
      if (!authResult.exists || !authResult.allowed) {
        // Either the request does not exist, or the offer was never accepted,
        // or the caller is not a participant. All indistinguishable.
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }
      const rows = await query<{
        id: string;
        service_request_id: string;
        customer_id: string;
        technician_id: string;
        status: string;
        created_at: string;
        updated_at: string;
        is_customer: boolean;
        is_technician: boolean;
        other_user_id: string | null;
        other_display_name: string | null;
        request_city: string | null;
        request_category: string | null;
        has_accepted_offer: boolean;
      }>(
        `SELECT c.id, c.service_request_id, c.customer_id, c.technician_id, c.status,
                c.created_at, c.updated_at,
                ($2 = c.customer_id) AS is_customer,
                ($2 = c.technician_id) AS is_technician,
                CASE WHEN $2 = c.customer_id THEN
                     (SELECT tu.id FROM users tu JOIN technicians t2 ON t2.user_id = tu.id WHERE t2.id = c.technician_id LIMIT 1)
                ELSE c.customer_id END AS other_user_id,
                COALESCE(
                  CASE WHEN $2 = c.customer_id THEN
                    (SELECT t3.name FROM technicians t3 WHERE t3.id = c.technician_id LIMIT 1)
                  ELSE (SELECT (u2.first_name || ' ' || u2.last_name) FROM users u2 WHERE u2.id = c.customer_id LIMIT 1)
                END, '') AS other_display_name,
                r.city AS request_city,
                r.category AS request_category,
                EXISTS (SELECT 1 FROM dispatch_offers o WHERE o.request_id = c.service_request_id AND o.status = 'accepted') AS has_accepted_offer
           FROM conversations c
           JOIN service_requests r ON r.id = c.service_request_id
          WHERE c.service_request_id = $1
          LIMIT 1`,
        [requestId, authUser.id],
      );
      const row = rows[0];
      // Task 33.1 fix: c.technician_id is a profile-row id, not a user id,
      // so the SQL is_technician flag can never be true for a technician.
      // Resolve the caller's own profile, like canAccessConversation does.
      const callerTech = await query<{ id: string }>(
        "SELECT id FROM technicians WHERE user_id = $1 LIMIT 1",
        [authUser.id],
      );
      const isTechnician =
        callerTech[0] !== undefined && row?.technician_id === callerTech[0].id;
      if (!row || !(row.is_customer || isTechnician)) {
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }
      return jsonResponse(reply, 200, {
        data: {
          conversation: {
            id: row.id,
            serviceRequestId: row.service_request_id,
            customerId: row.customer_id,
            technicianId: row.technician_id,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          otherParticipant: {
            userId: row.other_user_id,
            displayName: row.other_display_name || "Participant",
            isTechnician: row.is_customer,
            isCustomer: row.is_technician,
          },
          request: {
            id: row.service_request_id,
            city: row.request_city,
            category: row.request_category,
          },
          canCommunicate: row.status === "active" && row.has_accepted_offer,
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to load conversation" });
    }
  },
);

/**
 * GET /api/v1/conversations/:id/messages — cursor-paginated history for an
 * authorized participant. Cursor = `before` (a message id); the backend
 * returns messages strictly older than the referenced row.
 */
app.get(
  "/api/v1/conversations/:id/messages",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_MESSAGE_LIST", 120) },
  },
  async (request, reply) => {
    const { id: conversationId } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(conversationId);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    try {
      const access = await canAccessConversation(request, conversationId);
      if (!access.exists || !access.allowed) {
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }

      const parsed = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(25),
          before: z.string().uuid().optional(),
        })
        .safeParse(request.query ?? {});
      if (!parsed.success) {
        return jsonResponse(reply, 400, {
          error: "Validation failed",
          details: parsed.error.flatten(),
        });
      }
      const { limit, before } = parsed.data;

      let sql: string;
      const params: unknown[] = [conversationId, limit];
      if (before) {
        sql = `SELECT m.id, m.sender_id, m.message, m.created_at, m.read_at
                 FROM messages m
                WHERE m.conversation_id = $1
                  AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $3)
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT $2`;
        params.push(before);
      } else {
        sql = `SELECT m.id, m.sender_id, m.message, m.created_at, m.read_at
                 FROM messages m
                WHERE m.conversation_id = $1
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT $2`;
      }

      const rows = await query<{
        id: string;
        sender_id: string;
        message: string;
        created_at: string;
        read_at: string | null;
      }>(sql, params);

      const hasMore = rows.length === limit;
      // Newest-first in SQL is deliberate for pagination; the UI needs
      // chronological order, so reverse here rather than in the client.
      const ordered = [...rows].reverse();
      return jsonResponse(reply, 200, {
        data: {
          messages: ordered.map((r) => ({
            id: r.id,
            senderId: r.sender_id,
            message: r.message,
            createdAt: r.created_at,
            readAt: r.read_at,
          })),
          limit,
          hasMore,
          nextCursor: hasMore && ordered.length > 0 ? ordered[0].id : null,
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to load messages" });
    }
  },
);

/**
 * POST /api/v1/conversations/:id/messages — persist a new message.
 *
 * The ONLY client-supplied field is `message`. sender_id, created_at,
 * read_at and any ownership claim are derived server-side.
 */
app.post(
  "/api/v1/conversations/:id/messages",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_MESSAGE_SEND", 60) },
  },
  async (request, reply) => {
    const { id: conversationId } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(conversationId);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }

    // Strict schema: any extra field (senderId, customerId, technicianId,
    // createdAt, readAt, status...) is rejected outright rather than ignored.
    const parsed = z
      .object({
        message: z.string().trim().min(1, "Message cannot be empty").max(2000),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      return jsonResponse(reply, 400, {
        error: "Validation failed",
        details: parsed.error.flatten(),
      });
    }

    try {
      const access = await canAccessConversation(request, conversationId);
      if (!access.exists || !access.allowed) {
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }
      if (access.conversation.status !== "active") {
        return jsonResponse(reply, 400, {
          error: "This conversation is closed",
        });
      }

      const body = parsed.data.message;
      const inserted = await query<{
        id: string;
        sender_id: string;
        message: string;
        created_at: string;
        read_at: string | null;
      }>(
        `INSERT INTO messages (id, conversation_id, sender_id, message, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, sender_id, message, created_at, read_at`,
        [crypto.randomUUID(), conversationId, authUser.id, body],
      );
      const msg = inserted[0];

      // Realtime event, delivered only after the row is committed. A
      // transport failure never fails a persisted message.
      try {
        const ws = (
          app as unknown as {
            websocketServer?: {
              broadcastToConversation?: (id: string, e: unknown) => void;
            };
          }
        ).websocketServer;
        ws?.broadcastToConversation?.(conversationId, {
          type: "message",
          conversationId,
          messageId: msg.id,
          senderId: msg.sender_id,
          createdAt: msg.created_at,
        });
      } catch {
        /* transport failure never fails a persisted message */
      }

      // Notify the other participant through the existing pipeline. The
      // payload is deliberately generic: the message text stays in the
      // conversation and is fetched by the client under authorization.
      try {
        const otherRow = await query<{ id: string }>(
          `SELECT CASE
                      WHEN $1 = c.customer_id THEN
                        (SELECT tu.id FROM users tu JOIN technicians tt ON tt.user_id = tu.id WHERE tt.id = c.technician_id LIMIT 1)
                      ELSE c.customer_id
                    END AS id
             FROM conversations c WHERE c.id = $2 LIMIT 1`,
          [authUser.id, conversationId],
        );
        if (otherRow[0]?.id) {
          await recordAndDeliverEvent(
            {
              userId: otherRow[0].id,
              type: "chat_message",
              title: "New message",
              message: "You have received a new message.",
              referenceType: "conversation",
              referenceId: conversationId,
              // Chat is a STREAM of distinct events over one conversation
              // reference: conversation-level natural-key dedupe would let
              // only the FIRST message ever notify (Task 33.4). One row +
              // one delivery attempt per persisted message, for the
              // recipient only.
              dedupe: false,
            },
            (error) => app.log.error(error),
          );
        }
      } catch (error) {
        app.log.error(error);
      }

      return jsonResponse(reply, 201, {
        data: {
          id: msg.id,
          senderId: msg.sender_id,
          message: msg.message,
          createdAt: msg.created_at,
          readAt: msg.read_at,
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to send message" });
    }
  },
);

/**
 * PATCH /api/v1/conversations/:id/read — mark the OTHER participant's
 * messages as read. Only messages received from the other participant are
 * ever affected, so a session can never alter another person's read state.
 */
app.patch(
  "/api/v1/conversations/:id/read",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_MESSAGE_READ", 120) },
  },
  async (request, reply) => {
    const { id: conversationId } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(conversationId);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    try {
      const access = await canAccessConversation(request, conversationId);
      if (!access.exists || !access.allowed) {
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }
      const updated = await query<{ updated: string }>(
        `WITH affected AS (
           UPDATE messages SET read_at = NOW()
             WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL
           RETURNING 1
         )
         SELECT COUNT(*)::text AS updated FROM affected`,
        [conversationId, authUser.id],
      );
      return jsonResponse(reply, 200, {
        data: {
          conversationId,
          read: true,
          updated: Number(updated[0]?.updated ?? 0),
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to update read state" });
    }
  },
);

/**
 * GET /api/v1/requests/:id/contact — the authoritative phone number of the
 * OTHER participant in an accepted service relationship. Returns 404
 * honestly when no authoritative phone exists — never fabricates, never
 * derives a number from unrelated fields.
 */
app.get(
  "/api/v1/requests/:id/contact",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_MESSAGE_READ", 60) },
  },
  async (request, reply) => {
    const { id: requestId } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      assertUuid(requestId);
    } catch {
      return jsonResponse(reply, 400, { error: "Invalid id format" });
    }
    try {
      const authResult = await canCommunicateOnRequest(request, requestId);
      if (!authResult.allowed) {
        return jsonResponse(reply, 404, { error: "Request not found" });
      }
      const otherRows = await query<{
        other_user_id: string | null;
        status: string;
      }>(
        `SELECT CASE
                  WHEN $2 = r.customer_user_id THEN
                    (SELECT tu.id FROM users tu JOIN technicians tt ON tt.user_id = tu.id
                      JOIN dispatch_offers o ON o.technician_id = tt.id
                     WHERE o.request_id = r.id AND o.status = 'accepted' LIMIT 1)
                  ELSE r.customer_user_id
                END AS other_user_id,
                r.status
           FROM service_requests r
          WHERE r.id = $1
          LIMIT 1`,
        [requestId, authUser.id],
      );
      const row = otherRows[0];
      if (!row?.other_user_id) {
        return jsonResponse(reply, 404, {
          error: "No contact is available for this request.",
        });
      }
      const phoneRows = await query<{ phone_normalized: string }>(
        `SELECT phone_normalized FROM user_phones
          WHERE user_id = $1 AND purpose = 'service_contact'
          ORDER BY updated_at DESC LIMIT 1`,
        [row.other_user_id],
      );
      const phone = phoneRows[0]?.phone_normalized;
      if (!phone) {
        return jsonResponse(reply, 404, {
          error: "No contact number is available yet.",
        });
      }
      return jsonResponse(reply, 200, {
        data: { phone, tel: `tel:${phone}`, requestId, status: row.status },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, { error: "Failed to resolve contact" });
    }
  },
);

/**
 * GET /api/v1/me/conversations — the authenticated user's conversation list,
 * with the other participant, latest real message and real unread count.
 * No fabricated previews; an account with no conversations gets an empty list.
 */
app.get(
  "/api/v1/me/conversations",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_MESSAGE_LIST", 120) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    try {
      const rows = await query<{
        id: string;
        service_request_id: string;
        customer_id: string;
        technician_id: string;
        status: string;
        updated_at: string;
        created_at: string;
        is_customer: boolean;
        other_user_id: string | null;
        other_display_name: string | null;
        request_city: string | null;
        request_category: string | null;
        unread_count: string;
        last_message: string | null;
        last_message_at: string | null;
        last_message_sender_id: string | null;
      }>(
        `SELECT c.id, c.service_request_id, c.customer_id, c.technician_id, c.status,
                c.updated_at, c.created_at,
                (c.customer_id = $1) AS is_customer,
                CASE WHEN c.customer_id = $1 THEN
                  (SELECT tu.id FROM users tu JOIN technicians tt ON tt.user_id = tu.id WHERE tt.id = c.technician_id LIMIT 1)
                ELSE c.customer_id END AS other_user_id,
                COALESCE(
                  CASE WHEN c.customer_id = $1 THEN
                    (SELECT t.name FROM technicians t WHERE t.id = c.technician_id LIMIT 1)
                  ELSE (SELECT (u.first_name || ' ' || u.last_name) FROM users u WHERE u.id = c.customer_id LIMIT 1)
                END, '') AS other_display_name,
                r.city AS request_city,
                r.category AS request_category,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.conversation_id = c.id AND m.read_at IS NULL AND m.sender_id <> $1
                )::text AS unread_count,
                lm.message AS last_message,
                lm.created_at AS last_message_at,
                lm.sender_id AS last_message_sender_id
           FROM conversations c
           JOIN service_requests r ON r.id = c.service_request_id
           LEFT JOIN LATERAL (
             SELECT m2.message, m2.created_at, m2.sender_id
               FROM messages m2 WHERE m2.conversation_id = c.id
              ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1
           ) lm ON TRUE
          WHERE c.customer_id = $1
             OR EXISTS (SELECT 1 FROM technicians t2 WHERE t2.id = c.technician_id AND t2.user_id = $1)
          ORDER BY c.updated_at DESC
          LIMIT 50`,
        [authUser.id],
      );
      return jsonResponse(reply, 200, {
        data: {
          conversations: rows.map((r) => ({
            id: r.id,
            serviceRequestId: r.service_request_id,
            status: r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            otherParticipant: {
              userId: r.other_user_id,
              displayName: r.other_display_name || "Participant",
              isTechnician: r.is_customer,
            },
            request: {
              id: r.service_request_id,
              city: r.request_city,
              category: r.request_category,
            },
            unreadCount: Number(r.unread_count ?? 0),
            lastMessage: r.last_message
              ? {
                  message: r.last_message,
                  createdAt: r.last_message_at,
                  senderId: r.last_message_sender_id,
                }
              : null,
          })),
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to load conversations",
      });
    }
  },
);

/**
 * GET /api/v1/admin/conversations/:id — conversation METADATA for
 * administrators (Task 33.2 conversation-privacy policy).
 *
 * Policy: administrators never read, send or manipulate private messages —
 * every participant content route answers 404 for them. This is the single
 * explicitly authorized metadata surface, and it is deliberately metadata
 * only:
 *   - conversation identity, status and timestamps;
 *   - the linked request's identity, category, city and status;
 *   - participant ids and display names (the same identity data the admin
 *     request/technician tables already expose);
 *   - activity COUNTS and the last-activity TIMESTAMP.
 *
 * Never returned here: message bodies, message previews, per-message read
 * state, or phone numbers. Every successful read writes one
 * `admin.conversation_metadata_accessed` audit record through the existing
 * audit service, with no content in its metadata.
 */
app.get(
  "/api/v1/admin/conversations/:id",
  {
    preHandler: requireRole("administrator"),
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ADMIN", 60) },
  },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });
    assertUuid(id); // 400 → error handler (kept outside the catch below)
    try {
      const rows = await query<{
        id: string;
        service_request_id: string;
        status: string;
        created_at: string;
        updated_at: string;
        customer_id: string;
        customer_name: string | null;
        technician_id: string;
        technician_user_id: string | null;
        technician_name: string | null;
        request_category: string | null;
        request_city: string | null;
        request_status: string;
        message_count: number;
        last_message_at: string | null;
      }>(
        `SELECT c.id, c.service_request_id, c.status, c.created_at, c.updated_at,
                c.customer_id, c.technician_id,
                NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS customer_name,
                t.user_id AS technician_user_id,
                t.name AS technician_name,
                r.category AS request_category,
                r.city AS request_city,
                r.status AS request_status,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)::int AS message_count,
                (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
           FROM conversations c
           JOIN service_requests r ON r.id = c.service_request_id
           LEFT JOIN users u ON u.id = c.customer_id
           LEFT JOIN technicians t ON t.id = c.technician_id
          WHERE c.id = $1
          LIMIT 1`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        return jsonResponse(reply, 404, { error: "Conversation not found" });
      }

      // Existing audit infrastructure — one record per inspection, content-free.
      await recordAuditEvent({
        eventType: "admin.conversation_metadata_accessed",
        outcome: "success",
        actorUserId: authUser.id,
        actorRole: authUser.role,
        targetUserId: row.customer_id,
        targetEntityType: "conversation",
        targetEntityId: row.id,
        metadata: {
          route: "/api/v1/admin/conversations/:id",
          scope: "metadata_only",
          record_count: row.message_count,
        },
      });

      return jsonResponse(reply, 200, {
        data: {
          conversation: {
            id: row.id,
            serviceRequestId: row.service_request_id,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          participants: {
            customer: { userId: row.customer_id, displayName: row.customer_name },
            technician: {
              technicianId: row.technician_id,
              userId: row.technician_user_id,
              displayName: row.technician_name,
            },
          },
          request: {
            id: row.service_request_id,
            category: row.request_category,
            city: row.request_city,
            status: row.request_status,
          },
          activity: {
            messageCount: row.message_count,
            lastMessageAt: row.last_message_at,
          },
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to load conversation metadata",
      });
    }
  },
);

/**
 * GET /api/v1/me/requests — the caller's own service requests (Phase 4).
 *
 * §5 requires customers to see "current and recent service requests" and to
 * "view request details and history". That was impossible: a customer could
 * CREATE a request and fetch ONE by id, but no endpoint ever LISTED them, so
 * the sidebar's "My Requests" item could only point back at the create form.
 *
 * Scope is derived from the authenticated identity, never from a query
 * parameter. `scope` below is a constant string selected by role — no request
 * value is ever concatenated into the SQL, so the query stays parameterised:
 *   customer       → requests they own (customer_user_id)
 *   technician     → requests they hold/held an offer on (their job history)
 *   administrator  → empty list; platform-wide data is /admin/requests
 *
 * Additive and backward-compatible: no existing route or column changes.
 */
app.get(
  "/api/v1/me/requests",
  {
    preHandler: requireAuth,
    config: { rateLimit: routeRateLimit("RATE_LIMIT_ME_DATA", 60) },
  },
  async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser)
      return jsonResponse(reply, 401, { error: "Authentication required" });

    let scope: string;
    if (authUser.role === "customer") {
      scope = "r.customer_user_id = $1";
    } else if (authUser.role === "technician") {
      scope =
        "EXISTS (SELECT 1 FROM dispatch_offers o JOIN technicians t ON t.id = o.technician_id " +
        "WHERE o.request_id = r.id AND t.user_id = $1)";
    } else {
      return jsonResponse(reply, 200, { data: { requests: [] } });
    }

    try {
      const rows = await query<{
        id: string;
        description: string;
        category: string;
        city: string;
        status: string;
        created_at: string;
        updated_at: string;
        technician_name: string | null;
        offer_count: number;
      }>(
        `SELECT r.id, r.description, r.category, r.city, r.status,
                r.created_at, r.updated_at,
                (SELECT t.name FROM dispatch_offers o
                   JOIN technicians t ON t.id = o.technician_id
                  WHERE o.request_id = r.id AND o.status = 'accepted'
                  ORDER BY o.updated_at DESC LIMIT 1) AS technician_name,
                (SELECT COUNT(*) FROM dispatch_offers o
                  WHERE o.request_id = r.id)::int AS offer_count
           FROM service_requests r
          WHERE ${scope}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 100`,
        [authUser.id],
      );
      return jsonResponse(reply, 200, {
        data: {
          requests: rows.map((r) => ({
            id: r.id,
            description: r.description,
            category: r.category,
            city: r.city,
            status: r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            assignedTechnicianName: r.technician_name,
            offerCount: r.offer_count,
          })),
        },
      });
    } catch (error) {
      app.log.error(error);
      return jsonResponse(reply, 500, {
        error: "Failed to load your service requests",
      });
    }
  },
);

const port = Number(process.env.PORT ?? 3001);
// Task 28.4B / 33.3 — Realtime WebSocket transport. Mounted on the raw HTTP
// server at /api/v1/realtime and attached BEFORE `listen` so no early upgrade
// request can race the handler. If `ws` cannot be resolved the factory
// returns null and the REST API continues unchanged, with realtime logged as
// inactive rather than claimed. Events carry ids only; PostgreSQL stays
// authoritative (see realtime/websocketServer.ts).
const wsServer = createWebSocketServer(app);
if (wsServer) {
  app.log.info("Realtime WebSocket transport enabled at /api/v1/realtime");
} else {
  app.log.info(
    "Realtime transport inactive (`ws` package could not be resolved)",
  );
}
await app.listen({ port, host: "0.0.0.0" });
console.log(`Server listening on port ${port}`);

/* Task 36 (Stage 4) — in-process dispatch sweeper (Phase 5.4–6).
 *
 * Mounted AFTER a successful listen so a failed startup never leaves a
 * timer behind. One interval, three bounded jobs, each in its own
 * transaction:
 *   1. sweepExpiredOffers      — close pending offers past the response
 *                                window; the outcome path cascades to the
 *                                next candidate or falls back to no_match.
 *   2. sweepStuckMatchingRequests — recover requests stranded in 'matching'
 *                                with no pending offer (interrupted flow).
 *   3. sweepWaitingRequests    — re-offer no_match requests when capacity
 *                                returns (throttled, age-bounded).
 *
 * Never blocks request flow: every failure is logged and the next tick
 * retries. The interval is configurable (DISPATCH_SWEEP_INTERVAL_MS, min
 * 15s, default 60s) so the cadence can be tuned per environment.
 */
const dispatchSweepTimer = setInterval(() => {
  void (async () => {
    try {
      const expired = await sweepExpiredOffers();
      if (expired.expired > 0) {
        app.log.info({
          msg: "Offer timeout sweep",
          expired: expired.expired,
          advanced: expired.matched,
          fellBack: expired.fellBack,
        });
      }
    } catch (error) {
      app.log.error({ msg: "Offer timeout sweep failed", error });
    }
    try {
      const recovered = await sweepStuckMatchingRequests();
      if (recovered > 0) {
        app.log.info({
          msg: "Stuck dispatch recovery sweep",
          recovered,
        });
      }
    } catch (error) {
      app.log.error({ msg: "Stuck dispatch sweep failed", error });
    }
    try {
      const waiting = await sweepWaitingRequests();
      if (waiting.retried > 0) {
        app.log.info({
          msg: "Waiting request sweep",
          retried: waiting.retried,
          offered: waiting.matched,
        });
      }
    } catch (error) {
      app.log.error({ msg: "Waiting request sweep failed", error });
    }
  })();
}, sweepIntervalMs());
// The timer must never hold the process open on its own.
dispatchSweepTimer.unref();

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully");
  wsServer?.close();
  await pool.end();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully");
  wsServer?.close();
  await pool.end();
  process.exit(0);
});
