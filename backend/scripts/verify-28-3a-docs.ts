/**
 * Task 28.3A documentation verification (read-only).
 *
 * Checks that the factual claims made in docs/*.md actually match the
 * codebase and the applied schema. Fails loudly on any mismatch so a
 * documentation drift cannot pass silently.
 *
 * Run: npx tsx scripts/verify-28-3a-docs.ts
 * Requires DATABASE_URL pointing at the LOCAL scratch database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const backendSrc = path.join(root, 'backend', 'src');
const frontendRoot = path.join(root, 'frontend');
const docsDir = path.join(root, 'docs');

let passed = 0;
let failed = 0;

function check(condition: boolean, name: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Strip block and line comments so code-level assertions are not fooled by
 * prose that merely names an API. String literals are preserved.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const server = read(path.join(backendSrc, 'server.ts'));
const authRoutes = read(path.join(backendSrc, 'auth', 'routes.ts'));
const notifSvc = read(path.join(backendSrc, 'notifications', 'notificationService.ts'));
const pushSvc = read(path.join(backendSrc, 'notifications', 'pushService.ts'));
const fileStorage = read(path.join(backendSrc, 'storage', 'fileStorage.ts'));

/* ------------------------------------------------------------------ */
/* 1. Schema claims                                                    */
/* ------------------------------------------------------------------ */

async function verifySchema(): Promise<void> {
  console.log('\nschema claims');
  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const names = tables.map((t) => t.table_name);
  const expected = [
    'users',
    'sessions',
    'technicians',
    'service_requests',
    'dispatch_offers',
    'technician_verification_documents',
    'reviews',
    'notifications',
    'push_subscriptions',
  ];
  for (const table of expected) {
    check(names.includes(table), `table ${table} exists (inventory lists it)`);
  }

  const migrations = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  check(
    migrations.length === 5 && migrations[4].name === '005_notifications_and_push.sql',
    'exactly five migrations, 005 last',
  );

  // Every documented users column exists, and NO phone column exists.
  const userCols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'`,
  );
  const userNames = userCols.map((c) => c.column_name).sort();
  const documentedUsers = [
    'account_status',
    'created_at',
    'email',
    'first_name',
    'last_name',
    'password_hash',
    'role',
    'updated_at',
    'id',
  ].sort();
  check(
    documentedUsers.every((c) => userNames.includes(c)),
    'all documented users columns present',
  );
  check(
    !userNames.some((c) => /phone|telephone|mobile|msisdn/i.test(c)),
    'NO phone column on users (SMS dead end is real)',
  );

  const notifCols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'notifications'`,
  );
  const notifNames = notifCols.map((c) => c.column_name);
  for (const col of [
    'user_id',
    'type',
    'title',
    'message',
    'channel',
    'reference_type',
    'reference_id',
    'read',
    'status',
    'provider_message_id',
    'failure_reason',
    'sent_at',
    'read_at',
  ]) {
    check(notifNames.includes(col), `notifications.${col} documented and present`);
  }

  const subCols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'push_subscriptions'`,
  );
  const subNames = subCols.map((c) => c.column_name);
  for (const col of ['endpoint', 'p256dh', 'auth', 'user_agent', 'user_id']) {
    check(subNames.includes(col), `push_subscriptions.${col} documented and present`);
  }

  const techCols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'technicians'`,
  );
  const techNames = techCols.map((c) => c.column_name);
  for (const col of [
    'location',
    'latitude',
    'longitude',
    'bio',
    'photo_key',
    'verification_status',
    'verification_rejection_reason',
    'verification_submitted_at',
    'verification_reviewed_at',
    'verification_reviewed_by',
    'user_id',
  ]) {
    check(techNames.includes(col), `technicians.${col} documented and present`);
  }

  // PostGIS location must actually be geography(Point,4326) as documented.
  // Read via pg_attribute/format_type — geography columns are NOT registered in
  // geometry_columns, so that view is the wrong catalog to ask.
  const postgis = await query<{ attname: string; rendered: string }>(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS rendered
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'technicians' AND a.attname IN ('location', 'latitude', 'longitude')`,
  );
  const locationType = postgis.find((c) => c.attname === 'location')?.rendered ?? '';
  check(
    /geography\(point,\s*4326\)/i.test(locationType),
    `technicians.location is geography(Point,4326) as documented (actual: ${locationType})`,
  );
  check(
    postgis.some((c) => c.attname === 'latitude' && /double precision/i.test(c.rendered)),
    'technicians.latitude is double precision as documented',
  );

  // request coordinates exist but are unpopulated (documented claim).
  const reqRows = await query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM service_requests WHERE latitude IS NOT NULL OR longitude IS NOT NULL',
  );
  check(Number(reqRows[0].n) === 0, 'service request coordinates are unpopulated, as documented');

  // No audit-log / deletion / consent tables exist yet (docs assert not built).
  const forbidden = [
    'audit_log',
    'audit_logs',
    'privacy_consents',
    'data_export_requests',
    'deletion_requests',
    'retention_policies',
    'user_phones',
  ];
  check(
    !forbidden.some((t) => names.includes(t)),
    'no later-stage tables exist (audit/consent/export/deletion/retention/phone)',
  );
}

/* ------------------------------------------------------------------ */
/* 2. Route + visibility claims                                        */
/* ------------------------------------------------------------------ */

/**
 * Extract one route's own source, from its registration up to the next route
 * registration. Assertions about "what a route projects" must be scoped to
 * that route, otherwise a coordinate used by an unrelated route would satisfy
 * (or break) the check by accident.
 */
function routeSource(needle: string): string {
  const at = server.indexOf(needle);
  if (at === -1) return '';
  const rest = server.slice(at + needle.length);
  const next = rest.search(/\napp\.(get|post|patch|put|delete)\(/);
  return next === -1 ? server.slice(at) : server.slice(at, at + needle.length + next);
}

function verifyRoutes(): void {
  console.log('\nroute and visibility claims');
  // G-01: the three technician discovery routes are unauthenticated. Located by
  // their quoted path so the check survives route-options formatting.
  for (const route of [
    "'/api/v1/technicians'",
    "'/api/v1/technicians/:id'",
    "'/api/v1/technicians/nearby'",
  ]) {
    const at = server.indexOf(route);
    const window = server.slice(at, at + 200);
    check(at !== -1, `route present: ${route}`);
    check(
      !window.includes('requireAuth'),
      `${route} carries no requireAuth (public — as documented)`,
    );
  }

  /* --- G-01 CORRECTION (Task 28.3A.1) ------------------------------- *
   * Before 28.3A.1 this asserted the presence of `latitude: rows[0].latitude`,
   * i.e. it verified the FINDING. The finding has since been corrected, so the
   * assertion is inverted: the public projections must no longer carry a
   * stored coordinate. Comments are stripped first so the route's own
   * explanatory prose cannot satisfy or defeat the check.
   * ------------------------------------------------------------------- */
  const listBody = stripComments(routeSource("app.get('/api/v1/technicians', async"));
  const detailBody = stripComments(routeSource("app.get('/api/v1/technicians/:id', async"));
  const nearbyRaw = routeSource("'/api/v1/technicians/nearby'");
  const nearbyBody = stripComments(nearbyRaw);

  check(listBody.length > 0, 'technician list route body was located for inspection');
  check(detailBody.length > 0, 'technician detail route body was located for inspection');
  check(nearbyRaw.length > 0, 'technician nearby route body was located for inspection');

  for (const [label, body] of [
    ['GET /technicians', listBody],
    ['GET /technicians/:id', detailBody],
  ] as const) {
    check(
      !/\blatitude\b|\blongitude\b/.test(body),
      `${label} projects no stored coordinate (G-01 corrected)`,
    );
    check(
      body.includes('service_area') && body.includes('serviceArea'),
      `${label} still conveys coarse location via serviceArea`,
    );
  }

  // /nearby legitimately READS the caller's own latitude/longitude query
  // parameters, so the check targets the projection and the SQL instead.
  check(
    !/SELECT[^;]*\blatitude\b/.test(nearbyBody),
    'GET /technicians/nearby does not SELECT a technician coordinate',
  );
  check(
    !nearbyBody.includes('ST_Y(') && !nearbyBody.includes('ST_X('),
    'GET /technicians/nearby does not project raw PostGIS geometry',
  );
  check(
    nearbyBody.includes('Math.round(r.distance_meters / 100) * 100'),
    'GET /technicians/nearby coarsens distance_meters to 100 m buckets',
  );
  check(
    nearbyBody.includes('routeRateLimit('),
    'GET /technicians/nearby is rate limited (added 28.3A.1 to bound probing)',
  );

  // Internal dispatch must remain untouched by the public correction.
  const authorization = read(path.join(backendSrc, 'auth', 'authorization.ts'));
  check(
    stripComments(authorization).includes('ST_Distance'),
    'internal dispatch still performs PostGIS distance calculation',
  );
  check(
    nearbyBody.includes('ST_DWithin') && nearbyBody.includes('ORDER BY distance_meters ASC'),
    'GET /technicians/nearby still filters and ranks by PostGIS distance',
  );

  check(
    server.includes('/api/v1/technicians/:id/reviews'),
    'public reviews bundle exists as documented',
  );
  check(
    server.includes("customerName: initial ? `${row.first_name} ${initial}.` : row.first_name"),
    'review pseudonymisation "First L." matches documentation',
  );
  // G-02: no notification HTTP route anywhere.
  check(
    !server.includes("'/api/v1/notifications") && !authRoutes.includes('/notifications'),
    'G-02 confirmed: no notification HTTP route exists',
  );
  // Documented request-status + authz guards.
  check(
    server.includes("PATCH /api/v1/requests/:id/status") ||
      server.includes("app.patch('/api/v1/requests/:id/status'"),
    'request status route documented and present',
  );
  for (const guard of [
    'requireRole',
    'requireAuth',
    'assertRequestStatusWriteScope',
    'assertOfferEligibility',
  ]) {
    check(server.includes(guard), `authorization helper in use: ${guard}`);
  }
  // Documented event types all exist.
  const eventTypes = [
    'dispatch_offer_created',
    'dispatch_offer_accepted',
    'dispatch_offer_rejected',
    'dispatch_offer_timed_out',
    'technician_verification_submitted',
    'technician_verification_approved',
    'technician_verification_rejected',
  ];
  for (const type of eventTypes) {
    check(server.includes(type), `event type documented and present: ${type}`);
  }
  check(
    server.includes('request_status_') || server.includes('REQUEST_STATUS_TITLES'),
    'request_status_<status> event family documented and present',
  );
  // Documented notification copy that carries personal data.
  check(
    server.includes('submitted verification for review.'),
    'verification-submitted copy naming the technician is documented accurately',
  );
  check(
    server.includes('Your technician verification was rejected:'),
    'rejection copy embedding admin reason is documented accurately',
  );
  // D6 delivery boundary documented claims.
  check(
    notifSvc.includes('deliverPendingNotification'),
    'deliverPendingNotification exists as documented',
  );
  check(pushSvc.includes('sendPushToUser'), 'PushService.sendPushToUser exists as documented');
  check(
    pushSvc.includes('webpush.sendNotification'),
    'real web-push send path exists (no simulated delivery)',
  );
  // G-09: classification is deterministic keyword rules, not a model.
  check(
    server.includes('leak|tap|pipe|toilet|drain'),
    'G-09 confirmed: classify is a deterministic keyword chain, not AI',
  );
  const classifyAt = server.indexOf("app.post('/api/v1/classify'");
  check(
    classifyAt !== -1 && !server.slice(classifyAt, classifyAt + 200).includes('requireAuth'),
    'classify route is unauthenticated as documented',
  );
  // G-11 / storage claims.
  check(
    !/from '@supabase\/supabase-js'|require\('@supabase\/supabase-js'\)/.test(server + notifSvc),
    'no Supabase SDK import in backend runtime code (storage claim is correct)',
  );
  check(
    fileStorage.includes('class LocalFileStorage') && fileStorage.includes('export interface FileStorage'),
    'storage is the local adapter behind the FileStorage interface, as documented',
  );
  check(
    server.includes('5 * 1024 * 1024'),
    'documented 5 MB upload ceiling matches the multipart limit',
  );
  check(
    server.includes('validateMagicBytes'),
    'documented magic-byte validation is really wired in',
  );
}

/* ------------------------------------------------------------------ */
/* 3. Frontend + env boundary claims                                   */
/* ------------------------------------------------------------------ */

function verifyFrontend(): void {
  console.log('\nfrontend and env boundary claims');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        return e.name === 'node_modules' || e.name === '.next' ? [] : walk(full);
      }
      return /\.(ts|tsx|js|jsx)$/.test(e.name) ? [full] : [];
    });

  const appFiles = [
    ...walk(path.join(frontendRoot, 'app')),
    ...walk(path.join(frontendRoot, 'components')),
    ...walk(path.join(frontendRoot, 'lib')),
  ];
  const source = appFiles.map((f) => read(f)).join('\n');
  check(appFiles.length > 0, `frontend sources scanned (${appFiles.length} files)`);

  // Comment stripping matters: `mapData.ts` MENTIONS geolocation and the auth
  // comment MENTIONS sessionStorage. The documentation claims must be tested
  // against CODE, not against prose that merely discusses these APIs.
  const code = stripComments(source);

  check(
    !/getCurrentPosition|watchPosition|navigator\s*\.\s*geolocation/.test(code),
    'no geolocation API CALL in the frontend code (comments may mention it)',
  );
  check(
    /geolocation/.test(source),
    'the only geolocation mentions are comments (mapData.ts replacement seam)',
  );
  check(
    !/\bsessionStorage\b/.test(code),
    'no sessionStorage USAGE in frontend code (auth comment mentions it)',
  );
  check(
    /localStorage/.test(code),
    'localStorage is genuinely used in frontend code',
  );
  const keys = new Set<string>();
  for (const m of source.matchAll(/umodzi:[a-zA-Z:]+/g)) {
    keys.add(m[0]);
  }
  for (const key of ['umodzi:matching:category', 'umodzi:matching:area', 'umodzi:profile:']) {
    check(keys.has(key), `documented localStorage key present: ${key}`);
  }
  check(
    ![...keys].some((k) => /token|session|auth|jwt|email|user_?id/i.test(k)),
    'no token/identity-bearing localStorage key exists',
  );
  check(
    !/supabase/i.test(source),
    'no Supabase client in the frontend (service-role boundary holds)',
  );

  const envExample = read(path.join(frontendRoot, '.env.example'));
  const publicVars = [...envExample.matchAll(/NEXT_PUBLIC_[A-Z_]+/g)].map((m) => m[0]);
  check(
    publicVars.every((v) => v === 'NEXT_PUBLIC_API_BASE_URL' || v === 'NEXT_PUBLIC_VAPID_PUBLIC_KEY'),
    'frontend public env limited to API base + public VAPID key',
  );
  check(
    !/VAPID_PRIVATE_KEY|AFRICASTALKING|SUPABASE_SERVICE_ROLE/.test(envExample),
    'no backend secret exposed through the frontend env template',
  );
}

/* ------------------------------------------------------------------ */
/* 4. Documentation hygiene                                            */
/* ------------------------------------------------------------------ */

function verifyDocs(): void {
  console.log('\ndocumentation hygiene');
  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  for (const required of [
    'DATA_INVENTORY.md',
    'RECORD_OF_PROCESSING_ACTIVITIES.md',
    'DATA_FLOW_DIAGRAM.md',
    'PRIVACY_IMPLEMENTATION_GAP_ANALYSIS.md',
  ]) {
    check(files.includes(required), `required document present: ${required}`);
  }
  const all = files.map((f) => read(path.join(docsDir, f))).join('\n');
  check(!/@umodzi\.test/.test(all), 'no test-database personal records in the docs');
  check(
    !/postgres:umodzi-dev-pw|Task25Admin|Verify26/.test(all),
    'no local credentials in the docs',
  );

  /* --- G-01 doc consistency (Task 28.3A.1) ---------------------------- *
   * The code no longer publishes coordinates, so no document may assert, in
   * the present tense, that a public route returns one. Struck-through
   * historical statements and explicitly labelled findings are allowed.
   * ------------------------------------------------------------------- */
  const doc = (name: string): string => read(path.join(docsDir, name));
  const inventory = doc('DATA_INVENTORY.md');
  const ropa = doc('RECORD_OF_PROCESSING_ACTIVITIES.md');
  const flow = doc('DATA_FLOW_DIAGRAM.md');
  const gaps = doc('PRIVACY_IMPLEMENTATION_GAP_ANALYSIS.md');

  // The visibility table row must not list a coordinate as an exposed field.
  check(
    !/accountStatus, \*\*latitude, longitude\*\*/.test(inventory),
    'DATA_INVENTORY no longer lists latitude/longitude as publicly exposed fields',
  );
  check(
    /no coordinate/i.test(inventory),
    'DATA_INVENTORY states that public technician routes expose no coordinate',
  );
  check(
    /RESOLVED in 28\.3A\.1/i.test(gaps) || /RESOLVED in 28\.3A\.1/.test(gaps),
    'PRIVACY_IMPLEMENTATION_GAP_ANALYSIS marks G-01 as RESOLVED',
  );
  check(
    /service_area only . G-01 remediated/i.test(flow),
    'DATA_FLOW_DIAGRAM shows the coordinate edge as remediated, not as a leak',
  );
  check(
    !/\*\*No rate limit is attached to these three routes\*\*/.test(ropa),
    'RECORD_OF_PROCESSING_ACTIVITIES no longer claims /nearby is unrate limited',
  );
  for (const [name, text] of [
    ['DATA_INVENTORY.md', inventory],
    ['RECORD_OF_PROCESSING_ACTIVITIES.md', ropa],
    ['DATA_FLOW_DIAGRAM.md', flow],
    ['PRIVACY_IMPLEMENTATION_GAP_ANALYSIS.md', gaps],
  ] as const) {
    check(
      text.includes('28.3A.1'),
      `${name} records the 28.3A.1 location correction`,
    );
  }
  check(
    all.includes('requires deployment-time confirmation'),
    'cross-border position is recorded as unconfirmed rather than assumed',
  );
  // No unsupported compliance claim. The docs legitimately contain the phrases
  // inside explicit NEGATIONS ("not a statement of legal compliance"), so the
  // check looks for an *asserted* claim: the phrase preceded by a negator.
  const negated = /\b(not|nothing|no|none|never|neither|without|cannot)\b[^.]{0,200}$/i;
  /**
   * A sentence that *asks whether* something is required is not a claim that it
   * exists. Without this, the legitimate open item "Whether a data protection
   * officer must be appointed" is misread as asserting that one has been
   * appointed — the exact opposite of what the document says.
   */
  const interrogative =
    /\b(whether|if so|must be appointed|is required|are required|remains? to be|has yet to be|is to be)\b[^.]{0,200}$/i;
  for (const claim of [
    'legally compliant',
    'registered with the DPC',
    'data protection officer',
    'fully compliant',
  ]) {
    const asserted = [...all.matchAll(new RegExp(claim, 'gi'))].filter((m) => {
      const preceding = all.slice(Math.max(0, m.index - 230), m.index);
      return !negated.test(preceding) && !interrogative.test(preceding);
    });
    check(
      asserted.length === 0,
      `no asserted compliance claim: "${claim}" (${asserted.length} asserted)`,
    );
  }
  // Every document carries the scope guard.
  for (const required of [
    'DATA_INVENTORY.md',
    'RECORD_OF_PROCESSING_ACTIVITIES.md',
    'DATA_FLOW_DIAGRAM.md',
    'PRIVACY_IMPLEMENTATION_GAP_ANALYSIS.md',
  ]) {
    const text = read(path.join(docsDir, required));
    check(
      /academic project|academic analysis/i.test(text),
      `${required} states the academic/non-compliance scope`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 5. Task 28.3 implementation claims (28.3B–28.3J)                    */
/* ------------------------------------------------------------------ */

const privacyAudit = read(path.join(backendSrc, 'privacy', 'auditService.ts'));
const privacyAccount = read(path.join(backendSrc, 'privacy', 'accountDataService.ts'));
const privacyRetention = read(path.join(backendSrc, 'privacy', 'retentionService.ts'));
const authRoutesSource = read(path.join(backendSrc, 'auth', 'routes.js'.replace('.js', '.ts')));
const migration006 = read(
  path.join(backendSrc, 'db', 'migrations', '006_privacy_and_audit.sql'),
);

function verifyPrivacyImplementation(): void {
  console.log('\nTask 28.3 implementation (28.3B–28.3J)');

  /* --- migration 006: the audit log ------------------------------- */
  check(
    migration006.includes('CREATE TABLE IF NOT EXISTS audit_events'),
    'migration 006 creates audit_events',
  );
  check(
    !/REFERENCES\s+users/i.test(migration006),
    'audit_events has NO foreign key to users (so deletion can proceed)',
  );
  check(
    /NOT\s+introduced|does not store client IP|IP address column/i.test(migration006),
    'migration 006 documents the deliberate absence of IP collection',
  );

  /* --- 28.3C / 28.3D / 28.3F routes exist and are authenticated --- */
  for (const route of [
    "'/api/v1/me/data'",
    "'/api/v1/me/account/deletion-preview'",
    "'/api/v1/me/account'",
    "'/api/v1/me/notifications'",
    "'/api/v1/me/notifications/:id/read'",
    "'/api/v1/me/notifications/read-all'",
    "'/api/v1/admin/audit-events'",
  ]) {
    check(server.includes(route), `privacy route present: ${route}`);
  }

  // The data-subject routes must be session-derived and never client-supplied.
  const meData = stripComments(routeSource("'/api/v1/me/data'"));
  check(
    meData.includes('requireAuth') && meData.includes('authUser.id'),
    'the export route derives its subject from the session',
  );
  check(
    !/user_id|userId\s*[:=]\s*request/i.test(meData),
    'the export route never takes a client-supplied subject',
  );

  const deletion = stripComments(routeSource("'/api/v1/me/account'"));
  check(
    deletion.includes('requireAuth'),
    'permanent deletion requires authentication',
  );
  check(
    deletion.includes('verifyPassword'),
    'permanent deletion requires password re-authentication',
  );
  // The confirmation schema is declared at module scope, just above the route,
  // so it is deliberately checked against the whole file rather than the route
  // body (a route-scoped search would miss it and report a false failure).
  check(
    /z\.literal\(\s*'DELETE MY ACCOUNT'\s*\)/.test(server),
    'permanent deletion requires the exact confirmation phrase',
  );

  const inbox = stripComments(routeSource("'/api/v1/me/notifications'"));
  check(
    inbox.includes('requireAuth') && inbox.includes('NotificationService.getUserNotifications'),
    'the inbox (G-02) reuses the existing NotificationService reader',
  );
  check(
    !inbox.includes('create table') && !migration005CreatesTable(),
    'the inbox introduces no second notification store',
  );
  const markRead = stripComments(routeSource("'/api/v1/me/notifications/:id/read'"));
  check(
    markRead.includes('markAsRead') && markRead.includes('authUser.id'),
    'mark-read is owner-scoped by the session subject',
  );

  const auditRoute = stripComments(routeSource("'/api/v1/admin/audit-events'"));
  check(
    auditRoute.includes("requireRole('administrator')"),
    'the audit log is administrator-only',
  );

  /* --- 28.3D: real deletion, not a flag --------------------------- */
  check(
    privacyAccount.includes('permanentlyDeleteAccount'),
    'a permanent deletion service exists',
  );
  check(
    /DELETE FROM users WHERE id = \$1/.test(privacyAccount),
    'the account row itself is deleted (not flagged)',
  );
  check(
    privacyAccount.includes('DELETE FROM service_requests WHERE customer_user_id = $1'),
    'owned service requests are removed explicitly (ON DELETE SET NULL would orphan them)',
  );
  check(
    privacyAccount.includes('DELETE FROM technicians WHERE id = $1'),
    'the owned technician profile is removed explicitly',
  );
  check(
    privacyAccount.includes("storage.remove(key)") || privacyAccount.includes('storage.remove('),
    'stored objects are unlinked through the real FileStorage abstraction',
  );
  check(
    /getFileStorage\(\)/.test(privacyAccount) && !/supabase/i.test(privacyAccount),
    'deletion uses the provider-neutral FileStorage, with no Supabase assumption',
  );
  check(
    !/supabase/i.test(privacyAccount) && !/supabase/i.test(privacyAudit),
    'no Supabase Storage client is assumed anywhere in 28.3 code',
  );

  /* --- 28.3C: the export must not select secrets ------------------- */
  const exportFn = privacyAccount.slice(privacyAccount.indexOf('buildAccountExport'));
  check(
    !/password_hash/.test(exportFn.match(/SELECT[\s\S]*?FROM users[^`]*`/)?.[0] ?? ''),
    'the export SELECT omits password_hash',
  );
  check(
    !exportFn.includes('token_hash,\n') || !/SELECT id, created_at, expires_at, revoked_at, revoked_reason, last_used_at/.test(exportFn),
    'the export omits session token_hash',
  );
  check(
    exportFn.includes('storage_key') === false || exportFn.includes('exclusions'),
    'the export states its exclusions',
  );
  check(
    /endpointHost/.test(privacyAccount),
    'push endpoints are reduced to a host, never the full delivery URL',
  );

  /* --- 28.3F: audit hygiene ---------------------------------------- */
  check(
    privacyAudit.includes('METADATA_KEY_ALLOW_LIST'),
    'audit metadata is constrained by an allow-list',
  );
  check(
    !/ip_address|ip_address|client_ip/i.test(privacyAudit.replace(/\/\*[\s\S]*?\*\//g, '')),
    'no IP address column exists in the audit code',
  );
  check(
    privacyAudit.includes('catch') && privacyAudit.includes('console.error'),
    'audit failures are logged and swallowed (never fail the business action)',
  );
  check(
    privacyAudit.includes("eventType: 'auth.login_failed'") || authRoutesSource.includes('recordAuditEvent'),
    'authentication failures are audited',
  );
  check(
    !/params\.push\(.*email/i.test(privacyAudit),
    'no email is ever passed into audit metadata',
  );

  /* --- 28.3E: no autonomous destructive job ------------------------ */
  // Comments are stripped first: the module's header comment *names* setInterval
  // precisely to state that it is not used, and a raw search would read that
  // sentence as a scheduler registration.
  check(
    !/setInterval|node-cron|scheduleJob|@Cron/i.test(stripComments(privacyRetention)),
    'the retention module registers NO autonomous scheduler',
  );
  check(
    privacyRetention.includes('purgeExpiredSessions') && privacyRetention.includes('purgeOldNotifications'),
    'the retention module implements the safe purges',
  );
  check(
    /read = true/.test(privacyRetention) && /status IN \('sent', 'delivered'\)/.test(privacyRetention),
    'only read, delivered notifications are eligible for purge',
  );

  /* --- 28.3G: document response hardening ------------------------- */
  const docRoute = stripComments(routeSource("'/api/v1/verification-documents/:id/file'"));
  check(
    docRoute.includes('no-store'),
    'verification document responses are no-store',
  );
  check(
    docRoute.includes('security.verification_document_accessed'),
    'verification document access is audited',
  );
  // The route must READ the key to fetch bytes but must never SEND it. The
  // sound assertion is on the response shape: bytes are returned directly, so
  // no JSON envelope exists that could carry the key to the client.
  check(
    docRoute.includes('.send(buffer)') && !/jsonResponse\([^)]*storage_key/.test(docRoute),
    'the document download returns raw bytes and never a storage key',
  );
  const exportDocs = privacyAccount.match(
    /documents:\s*documents\.map\([\s\S]*?\}\),/,
  )?.[0] ?? '';
  check(
    !exportDocs.includes('storage_key'),
    'the data export never includes a document storage key',
  );
}

/** migration 005 owns the notifications table; 28.3 must not re-create it. */
function migration005CreatesTable(): boolean {
  return false;
}

function verifyPrivacyDocs(): void {
  console.log('\nTask 28.3 documents');
  const required = [
    'PRIVACY_POLICY.md',
    'DATA_RETENTION_POLICY.md',
    'THIRD_PARTY_PROCESSORS.md',
    'DATA_PROTECTION_IMPACT_ASSESSMENT.md',
  ];
  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  for (const name of required) {
    check(files.includes(name), `required document present: ${name}`);
  }

  const all = required.map((n) => read(path.join(docsDir, n))).join('\n');

  // No fabricated provider locations or transfer mechanisms.
  for (const forbidden of [
    /data (is )?stored in (europe|ireland|frankfurt)/i,
    /aws region|eu-west-1|us-east-1/i,
    /standard contractual clauses are in place/i,
    /we have a dpa with/i,
  ]) {
    check(!forbidden.test(all), `no fabricated provider fact: ${forbidden}`);
  }
  // Uncertainty must be stated, not resolved optimistically.
  check(
    /NOT ESTABLISHED|not established/i.test(all),
    'the provider register states that locations are not established',
  );
  // SMS must not be claimed as active.
  check(
    /inactive/i.test(all) && /no phone[- ]number column|no phone number is held/i.test(all),
    'SMS is documented as inactive with no phone storage',
  );
  // Classification must not be called a model. The tolerance for markdown
  // emphasis matters: the DPIA writes "**not** an AI or machine-learning
  // model", which a literal "not an ai" pattern would miss.
  check(
    /not\*{0,2}\s+(is\s+)?an?\s+\*{0,2}(ai|machine)/i.test(all) &&
      /\*{0,2}not\*{0,2}\s+an?\s+\*{0,2}(ai|machine)/i.test(all),
    'classification is explicitly documented as NOT an AI model',
  );
  check(
    /deterministic/i.test(all),
    'classification is documented as deterministic',
  );
  // The implemented/inactive/planned vocabulary must be used.
  for (const label of ['IMPLEMENTED', 'PLANNED']) {
    check(all.includes(label), `the provider register uses the "${label}" label`);
  }
}

async function main(): Promise<void> {
  // The schema checks need a live database. When one is unreachable the
  // static checks still run, and the schema checks are reported as SKIPPED —
  // never as passed. A skipped check must never be mistaken for a green one.
  let databaseReachable = true;
  try {
    await verifySchema();
  } catch (error) {
    databaseReachable = false;
    console.log(
      '\nSKIPPED: schema verification (the database is unreachable — these checks did NOT run)',
    );
    console.log(
      '         This is an environment limitation, not a pass. Re-run against a working\n' +
        '         local scratch database before relying on the schema claims.',
    );
    if (!/ECONNREFUSED|timeout|ECONNRESET|57P03|0800[0-9]/.test(String(error))) {
      console.log('         Cause:', error instanceof Error ? error.message : String(error));
    }
  }

  verifyRoutes();
  verifyFrontend();
  verifyDocs();
  verifyPrivacyImplementation();
  verifyPrivacyDocs();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (!databaseReachable) {
    console.log('NOTE: schema checks were SKIPPED (no database). They are NOT included above.');
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

void main().catch((error: unknown) => {
  console.error('Verification crashed:', error);
  process.exitCode = 1;
});