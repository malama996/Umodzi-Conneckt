# CHAT / REALTIME DEFECT — ROOT CAUSE AND FIX

**Reported:** live chat does not work on the deployed system.
**Status:** root cause identified and fixed in source; redeployment required.
**Files changed:** `backend/src/realtime/websocketServer.ts`, `frontend/lib/chat/useChatRealtime.ts`.

---

## 1. The defect

The browser could never complete the WebSocket handshake. Every connection died
at the upgrade, so a conversation page showed "Live updates are paused" and new
messages from the other party never appeared until the page was reloaded.

## 2. Why it happened

The session token must travel in the handshake, and a browser cannot set an
`Authorization` header on a WebSocket upgrade. The standard workaround is to
offer the token as a **subprotocol**:

```ts
new WebSocket(url, [`bearer-${token}`]);
```

RFC 6455 §4.1 then requires the server's `101 Switching Protocols` response to
name **one of the offered subprotocols**. If the client offered any and the
response names none, the browser MUST fail the connection.

`ws` only writes that header when a `handleProtocols` hook is supplied. The
server was constructed without one:

```ts
const wss = new mod.WebSocketServer({ noServer: true, maxPayload: 4096 });
```

With no hook, `ws` sends no `Sec-WebSocket-Protocol` header. Chrome and Firefox
reject the handshake, and the socket never reaches the `connection` handler —
no `connected` event, no `subscribed` event, no messages.

## 3. Why the test suite did not catch it

`backend/scripts/task333-realtime-tests.ts` connects with Node's `ws` **client**,
which tolerates a missing subprotocol echo. The server therefore looked healthy
to the only automated test that touches the transport, while no browser could
connect at all. This is exactly the gap the earlier tracker recorded — 45
scripts existed but were never executed — and it shows why executing them
matters: the suite would have passed anyway.

## 4. The fix

```ts
handleProtocols: (protocols: Set<string>) => {
  for (const protocol of protocols) {
    if (protocol.startsWith('bearer-')) return protocol;
  }
  return false;
},
```

Echoing the offered `bearer-…` entry satisfies the browser and changes no
security property:

- the same token already travelled in the request header;
- `authenticateHandshake()` still verifies signature, issuer, audience and
  expiry with the same `verifyAccessToken()` HTTP uses;
- the account is still re-read from PostgreSQL, so a suspended user is refused;
- conversation access is still decided by `canAccessConversation()`.

A client that offers no token receives no echo and is closed with code 4001.

## 5. Second, smaller fix

The client fetched only the newest message (`limit: 1`) when an event arrived
and silently dropped the event if that single row was not the one named. Two
messages arriving together could lose one until reload. It now fetches a short
newest page and merges by stable id, so a burst cannot lose an event. The hook
also exposes `subscribed` so "socket open but subscription refused" is
distinguishable from "socket refused".

## 6. Verification performed

| Check | Result |
|---|---|
| `backend: npx tsc --noEmit` | PASS (exit 0) |
| `frontend: npm run typecheck` | PASS (exit 0) |
| `frontend: eslint` | PASS |
| `frontend: next build` (Node 22) | PASS (exit 0) |

**Not performed:** no browser connection was made, because that needs the
backend running against a database. The browser handshake must be confirmed
after redeployment (below).

## 7. What to do after deploying

1. Redeploy the backend (Render) — the server-side change is the one that
   matters. The frontend change is a robustness improvement, not the fix.
2. Open a conversation in two browser windows as the two participants.
3. In DevTools → Network → WS, confirm the connection shows
   `101 Switching Protocols` **and** a `Sec-WebSocket-Protocol: bearer-…`
   response header.
4. Send a message from one window; it should appear in the other without a
   reload.
5. Confirm the chat header no longer shows "Live updates are paused".

If step 3 still shows no subprotocol echo, the deployed build is stale — check
that Render rebuilt from the commit containing this change.

## 8. Scope note

Persistence was never affected: messages are written by HTTP and remain in
`messages`; sending and reloading always worked. Only the live push of new
messages was broken. Say exactly that if asked — "the transport was down, the
data was never at risk" is the accurate description.
