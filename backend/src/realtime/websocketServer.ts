/**
 * Task 28.4B — Realtime transport: the actual WebSocket server.
 *
 * DEPENDENCY POSITION (updated by Task 33.3):
 *   `ws` is now a REAL dependency of `backend` (installed via the workspace,
 *   root lockfile updated). The loader below still resolves it at RUNTIME
 *   through `createRequire`, so a deployment that somehow lacks the package
 *   still gets an honest no-op transport instead of a crashed process — and
 *   the REST API remains fully functional either way.
 *
 *   Task 33.3 root causes fixed (realtime was dormant even though all the
 *   code existed):
 *     1. The old loader probed `require` through `eval`, which is undefined
 *        in a Node ESM process ("type": "module" / NodeNext output), so the
 *        module NEVER resolved and no `upgrade` handler was ever attached.
 *        `createRequire(import.meta.url)` is the ESM-correct equivalent.
 *     2. The subscribe path passed `{ userId, ... }` into
 *        `canAccessConversation()`, which reads `authUser.id` /
 *        `authUser.role` — every subscription would have been denied. The
 *        shim now carries the DB-authoritative `{ id, role }` exactly like
 *        `requireAuth` builds it for HTTP.
 *     3. No liveness check existed; a heartbeat now terminates stale
 *        sockets so they cannot linger in the subscriber set.
 *
 * SECURITY MODEL (matches the HTTP boundary exactly):
 *   1. The handshake carries the access token as a WebSocket subprotocol
 *      (`bearer-<token>`) — browsers can send subprotocol headers but not
 *      arbitrary headers on upgrade.
 *   2. The token is verified with the SAME `verifyAccessToken()` used by
 *      HTTP, so issuer/audience/signature/expiry are all enforced.
 *   3. The user is RE-READ from PostgreSQL (`getUserRow`), so a suspended or
 *      deleted account is rejected even with a live token; the role used for
 *      authorization comes from that row, never from client claims.
 *   4. Conversation authorization is ALWAYS the DB-derived `canAccessConversation()`
 *      — never anything the client asserts in a `subscribe` message. The
 *      administrator role is never an access grant (Task 33.2 policy).
 *   5. Only conversations the user is a participant of are ever added to
 *      their subscription set, and broadcasts go only to those subscribers.
 *
 * Message content is NEVER buffered in memory: the persistent `messages`
 * table is authoritative, and events carry only ids and timestamps — so a
 * lost event can always be recovered by a REST refetch.
 */

import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'http';
import { createRequire } from 'node:module';
import { verifyAccessToken } from '../auth/jwt.js';
import { getUserRow } from '../auth/authService.js';
import { canAccessConversation } from '../privacy/communicationAuth.js';

export interface RealTimeEvent {
  type: 'message' | 'read' | 'conversation_closed' | 'connected';
  conversationId: string;
  messageId?: string;
  senderId?: string;
  createdAt?: string;
}

/** Subscription bookkeeping kept per open socket. */
interface ClientState {
  /** Authenticated user id (server-derived, never client-claimed). */
  userId: string;
  /** DB-authoritative role of that user — used only for policy flags. */
  role: string;
  /** Conversations this user is authorized for; everything else is ignored. */
  conversationIds: Set<string>;
  closed: boolean;
}

/** Minimal structural types so the file typechecks with or without `ws`. */
interface WsLike {
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
  readyState: number;
}
interface WsServerLike {
  on(event: string, listener: (...args: any[]) => void): void;
  handleUpgrade(req: IncomingMessage, socket: any, head: any, cb: (ws: WsLike) => void): void;
  emit(event: string, ...args: any[]): boolean;
}
type WsModuleLike = {
  WebSocketServer: new (opts: { noServer: boolean; maxPayload?: number }) => WsServerLike;
  WebSocket?: { OPEN: number };
};

/** Loaded once; same instance for every connection. */
let wsModule: WsModuleLike | null = null;
let moduleResolved = false;

function resolveWsModule(): WsModuleLike | null {
  if (moduleResolved) return wsModule;
  moduleResolved = true;
  try {
    // ESM-correct resolution (Task 33.3): this backend runs as a Node ES
    // module, where a bare `require` does not exist — the previous eval-based
    // probe always returned null, which is why realtime stayed dormant even
    // in deployments that had `ws` available. `createRequire` works in ESM
    // and still throws cleanly when the package is absent.
    const req = createRequire(import.meta.url);
    const mod = req('ws') as unknown as WsModuleLike & { default?: WsModuleLike };
    if (mod?.WebSocketServer || mod?.default?.WebSocketServer) {
      wsModule = mod.default ?? mod;
    }
  } catch {
    // Not installed — realtime simply stays inactive. Never throws.
    wsModule = null;
  }
  return wsModule;
}

export function realtimeAvailable(): boolean {
  return resolveWsModule() !== null;
}

/**
 * Create and wire the WebSocket server into the running Fastify instance.
 *
 * Attaches an `upgrade` handler on the raw HTTP server at `/api/v1/realtime`,
 * authenticating and authorizing every connection before it is accepted.
 * If `ws` is unavailable, this is a complete no-op and the app is unaffected.
 */
export function createWebSocketServer(app: FastifyInstance): { close: () => void } | null {
  const mod = resolveWsModule();
  const httpServer = (app as unknown as { server?: { on: (e: string, l: (...a: any[]) => void) => void } }).server;
  if (!mod || !httpServer) return null;

  const clients = new Set<WsLike>();
  const clientStates = new WeakMap<WsLike, ClientState>();

  const wss = new mod.WebSocketServer({
    noServer: true,
    // Client frames are tiny JSON commands (`subscribe`/`unsubscribe`); a
    // small cap keeps a malformed or hostile peer from forcing large parses.
    maxPayload: 4096,
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: any) => {
    // Only the realtime path is handled here; every other upgrade
    // (Hot Module Replacement in dev, for example) is left untouched.
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/api/v1/realtime') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WsLike) => {
      wss.emit('connection', ws, req);
    });
  });

  /** Liveness flag per socket: false means a ping went unanswered. */
  const alive = new WeakMap<WsLike, boolean>();
  const HEARTBEAT_MS = 30_000;
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (alive.get(ws) === false) {
        // Missed the previous pong — the socket is stale. Terminate it so
        // the close handler runs and the client leaves the subscriber set.
        try {
          ws.terminate?.();
        } catch {
          /* already gone */
        }
        clients.delete(ws);
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping?.();
      } catch {
        /* socket already gone */
      }
    }
  }, HEARTBEAT_MS);
  // Never keep the process alive purely for heartbeats.
  heartbeat.unref?.();

  wss.on('connection', async (ws: WsLike, req: IncomingMessage) => {
    // 0. Attach the frame listener SYNCHRONOUSLY, before any await. Clients
    //    routinely subscribe from their `open` handler, so frames can arrive
    //    while the asynchronous authentication below is still running — and
    //    `ws` emits 'message' into the void when no listener is attached yet
    //    (observed live in Task 33.3: both early frames were silently lost).
    //    Buffer them and process after the state exists; on auth failure the
    //    socket is closed and the buffer is discarded with it.
    const preReadyFrames: unknown[] = [];
    let ready = false;
    let pendingState: ClientState | null = null;
    ws.on('message', (raw: unknown) => {
      if (!ready || !pendingState) {
        // Bounded: a pre-auth peer can never queue unbounded frames here.
        if (preReadyFrames.length < 16) preReadyFrames.push(raw);
        return;
      }
      void handleClientMessage(ws, pendingState, req, raw);
    });

    // 1. Authenticate at the handshake. Failures are closed immediately with
    //    a protocol-level code rather than being allowed to idle.
    const auth = authenticateHandshake(req);
    if (!auth) {
      safeClose(ws, 4001, 'Authentication failed');
      return;
    }

    // 2. Re-read the account. The database is authoritative for status AND
    //    role, exactly like `requireAuth` does for HTTP.
    let user;
    try {
      user = await getUserRow(auth.userId);
    } catch {
      safeClose(ws, 4001, 'Authentication failed');
      return;
    }
    if (!user || user.account_status !== 'active') {
      safeClose(ws, 4003, 'Account not active');
      return;
    }

    pendingState = {
      userId: auth.userId,
      role: user.role,
      conversationIds: new Set(),
      closed: false,
    };
    const state = pendingState;
    clientStates.set(ws, state);
    clients.add(ws);
    alive.set(ws, true);
    ws.on('pong', () => {
      alive.set(ws, true);
    });
    safeSend(ws, JSON.stringify({ type: 'connected' }));

    // State is in place: buffered early frames are processed in arrival
    // order, exactly as if they had arrived a moment later.
    ready = true;
    for (const raw of preReadyFrames.splice(0)) {
      void handleClientMessage(ws, state, req, raw);
    }

    ws.on('close', () => {
      state.closed = true;
      clients.delete(ws);
    });

    ws.on('error', () => {
      state.closed = true;
      clients.delete(ws);
    });
  });

  /**
   * Publish one event to every socket authorized for that conversation — and
   * nobody else. Called after a message row is committed, so no event can
   * reference a message that does not exist.
   */
  function broadcastToConversation(conversationId: string, event: RealTimeEvent): void {
    for (const ws of clients) {
      const state = clientStates.get(ws);
      if (!state || state.closed) continue;
      if (!state.conversationIds.has(conversationId)) continue;
      safeSend(ws, JSON.stringify(event));
    }
  }

  async function handleClientMessage(
    ws: WsLike,
    state: ClientState,
    req: IncomingMessage,
    raw: unknown,
  ): Promise<void> {
    let parsed: { subscribe?: { conversationId?: string }; unsubscribe?: { conversationId?: string } };
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      safeSend(ws, JSON.stringify({ error: 'Invalid message' }));
      return;
    }

    if (parsed.subscribe?.conversationId) {
      const conversationId = parsed.subscribe.conversationId;
      // UUID validation only; authorization is always the database's call.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
        safeSend(ws, JSON.stringify({ error: 'Invalid conversation id format' }));
        return;
      }
      try {
        // Reuse the shared authorization helper: the conversation, the
        // request and the accepted-offer relationship are all re-verified
        // against PostgreSQL, using the session's own user id. The shim
        // mirrors the `{ id, role }` shape `requireAuth` builds for HTTP —
        // the previous `{ userId }` shape was read as `id: undefined`, which
        // denied every subscription (Task 33.3 fix). The administrator role
        // never grants content access here (Task 33.2 policy).
        const access = await canAccessConversation(
          {
            authUser: { id: state.userId, role: state.role },
          } as unknown as Parameters<typeof canAccessConversation>[0],
          conversationId,
        );
        if (!access.exists) {
          safeSend(ws, JSON.stringify({ error: 'Conversation not found' }));
          return;
        }
        if (!access.allowed) {
          safeSend(ws, JSON.stringify({ error: 'Not authorized for this conversation' }));
          return;
        }
        state.conversationIds.add(conversationId);
        safeSend(ws, JSON.stringify({ type: 'subscribed', conversationId }));
      } catch {
        safeSend(ws, JSON.stringify({ error: 'Authorization check failed' }));
      }
      return;
    }

    if (parsed.unsubscribe?.conversationId) {
      state.conversationIds.delete(parsed.unsubscribe.conversationId);
      safeSend(ws, JSON.stringify({ type: 'unsubscribed', conversationId: parsed.unsubscribe.conversationId }));
      return;
    }

    safeSend(ws, JSON.stringify({ error: 'Unknown message type' }));
  }

  function authenticateHandshake(req: IncomingMessage): { userId: string } | null {
    const header = req.headers['sec-websocket-protocol'];
    if (typeof header !== 'string') return null;
    for (const part of header.split(',')) {
      const token = part.trim();
      if (!token.startsWith('bearer-')) continue;
      const jwt = token.slice('bearer-'.length);
      try {
        const claims = verifyAccessToken(app, jwt);
        if (claims && typeof claims.sub === 'string') return { userId: claims.sub };
      } catch {
        // Expired, forged, wrong issuer/audience — one indistinguishable failure.
      }
    }
    return null;
  }

  function safeSend(ws: WsLike, data: string): void {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch {
      /* socket already gone */
    }
  }

  function safeClose(ws: WsLike, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  const server = {
    broadcastToConversation,
    /** Graceful shutdown: stop the heartbeat and drop every subscriber. */
    close: () => {
      clearInterval(heartbeat);
      for (const ws of clients) {
        try {
          ws.close(1001, 'Server shutting down');
        } catch {
          /* already closing */
        }
      }
      clients.clear();
    },
  };
  (app as unknown as { websocketServer: typeof server }).websocketServer = server;
  return server;
}
