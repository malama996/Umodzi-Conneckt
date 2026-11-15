# Demo environment — local and deployed

Everything here is for the presentation. Nothing in it can reach the hosted database.

## Files

| File | Purpose | Committed? |
|---|---|---|
| `backend/.env.demo` | Full local demo config: local Postgres, demo admin, relaxed limits | **No** (`.env.*` is ignored) |
| `frontend/.env.demo` | Points the UI at `http://localhost:3001/api/v1` | **No** |
| `frontend/.env.deployed.example` | Template for talking to your live API | Yes |

The backend generates its JWT secret per machine when the file was created, so no shared secret is
stored in this repository.

## Local demo — step by step

```bash
# 1. Backend config (keeps your current one as a backup)
cp backend/.env backend/.env.backup
cp backend/.env.demo backend/.env

# 2. Frontend config
cp frontend/.env.demo frontend/.env.local

# 3. Database, once
npm run migrate -w backend
npm run seed -w backend
npm run seed:demo -w backend

# 4. Run
npm run dev -w backend      # http://localhost:3001
npm run dev -w frontend     # http://localhost:3000
```

Restore afterwards with `cp backend/.env.backup backend/.env`.

`seed:demo` is idempotent and refuses any non-loopback `DATABASE_URL`, so it cannot touch the
hosted database even if the env file is wrong.

## Demo accounts

Password for all three: `Demo2026!Local` (from `DEMO_PASSWORD` in `backend/.env.demo`).

| Account | Role | Ready for |
|---|---|---|
| `admin@umodzi.demo` | administrator | verification queue, users, audit trail |
| `customer@umodzi.demo` | customer | create request, classification, offers, chat, review |
| `tech@umodzi.demo` | technician | offers, accept, chat, profile — verified + available in Plumbing/Kitwe |

The technician satisfies every dispatch condition (verified, available, active, has an account), so
a customer request in **Plumbing / Kitwe** dispatches to them immediately. That is the pair to use
for the live chat demonstration.

## Flow to rehearse

1. Sign in as the customer → create a Plumbing / Kitwe request.
2. Offer appears → sign in as the technician (second browser profile) → accept.
3. Both open **Messages** → send, reply, refresh, watch the unread badge.
4. Customer marks the job in progress, then completes it, and leaves a review.
5. Admin → verification queue and audit trail.

## Pointing at the deployed system

Copy `frontend/.env.deployed.example` to `frontend/.env.local` and set the real API origin, then
restart `next dev`. Two things must line up or the session will not survive:

1. **CORS.** The backend only accepts the origins in `FRONTEND_ORIGIN`. If you serve the UI from
   `http://localhost:3000` but call a deployed API, that origin must be listed on the deployed
   backend, or every request fails.
2. **Cookies.** The refresh token is an httpOnly cookie. Cross-site (localhost → deployed https)
   needs `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none` on the server, and browsers increasingly
   block third-party cookies. If refresh looks flaky, demonstrate the **deployed site itself**
   rather than a local UI pointed at it — same origin, no cookie problems.

For the presentation, the local demo above is the safer path: no network dependency on venue Wi-Fi.

## What is deliberately blank

`GEMINI_API_KEY`, `VAPID_*`, `SMS_PROVIDER`, `RESEND_API_KEY` and the Africa's Talking / Twilio
values are empty. Unconfigured means the feature reports itself unavailable — the keyword classifier
and manual category selection take over, push stays off, and no fake success is shown. Fill them in
only if you want those paths live.
