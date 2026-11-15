# Demonstration environment

The demonstration runs entirely on one laptop against a dedicated local database,
`umodzi_demo`. It is separate from the test database (`umodzi_test`) and from the hosted
Supabase project, so rehearsal data and test fixtures never mix.

## Files

| File | Purpose | Committed |
|---|---|---|
| `backend/.env.demo` | Complete local configuration | No — `.env.*` is git-ignored |
| `frontend/.env.demo` | Points the UI at the local API | No |
| `frontend/.env.deployed.example` | Template for calling the deployed API | Yes |

The backend's signing key is generated per machine, so no shared secret is stored in the repository.

## First-time setup

```bash
# 1. Create the database (PostgreSQL 18 with PostGIS, as in docs/DATABASE-SETUP.md)
"C:/Program Files/PostgreSQL/18/bin/psql" -U postgres -h localhost -d postgres -c "CREATE DATABASE umodzi_demo;"

# 2. Activate the demo configuration
cp backend/.env backend/.env.backup
cp backend/.env.demo backend/.env
cp frontend/.env.demo frontend/.env.local

# 3. Schema, baseline technicians, demo accounts
npm run migrate -w backend
npm run seed -w backend
npm run seed:demo -w backend

# 4. Run both processes (two terminals)
npm run dev -w backend      # http://localhost:3001
npm run dev -w frontend     # http://localhost:3000
```

The frontend must run on port 3000: the API accepts only the origins listed in
`FRONTEND_ORIGIN`, and any other port fails with "Unable to reach the server".

`seed:demo` is idempotent and refuses a non-loopback `DATABASE_URL`, so it cannot touch the
hosted database.

## Resetting between rehearsals

```bash
"C:/Program Files/PostgreSQL/18/bin/psql" -U postgres -h localhost -d postgres -c "DROP DATABASE umodzi_demo;" -c "CREATE DATABASE umodzi_demo;"
npm run migrate -w backend && npm run seed -w backend && npm run seed:demo -w backend
```

## Accounts

Password for all three: `Demo2026!Local`

| Account | Role | What it demonstrates |
|---|---|---|
| `admin@umodzi.demo` | administrator | overview, users, technicians, requests, audit trail |
| `customer@umodzi.demo` | customer | request creation, offers, chat, completion confirmation, review |
| `tech@umodzi.demo` | technician | offer inbox, accept, job progress, chat, completion |

The technician is verified, available, active and linked to a user account, so a request in
**Plumbing / Kitwe** is offered to them immediately. Use this pair for the live chat segment.

## Lifecycle to rehearse

Status changes are role-specific, and the sequence below is the one the API accepts:

1. Customer signs in and creates a Plumbing / Kitwe request → status `matching`.
2. An offer is created for the technician → technician sees it in the offer inbox.
3. Technician accepts → request becomes `matched` and a conversation is created.
4. Both sides exchange messages in **Messages**; unread counts update on read.
5. Technician starts the work (`in_progress`), then records completion (`completed`).
6. Customer leaves a review; the technician's rating updates.
7. Administrator reviews the request and audit trail.

Customers may cancel a request, or confirm completion only after work has started. Only the
technician awarded the work can start or complete it.

## Pointing the UI at the deployed system

Copy `frontend/.env.deployed.example` to `frontend/.env.local`, set the deployed API origin
(ending in `/api/v1`), and restart `next dev`. Two conditions must be met:

1. **CORS** — the deployed backend must list the origin you serve from in `FRONTEND_ORIGIN`.
2. **Cookies** — the refresh token travels in an httpOnly cookie. Cross-site use needs
   `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`, and browsers increasingly block
   third-party cookies. Demonstrating the deployed site directly avoids both problems.

For the presentation, the local setup above is safer: no dependency on venue connectivity.

## Deliberately unconfigured

`GEMINI_API_KEY`, `VAPID_*`, `SMS_PROVIDER`, `RESEND_API_KEY` and the Africa's Talking / Twilio
values are blank. The application reports those features as unavailable instead of faking
success: the keyword classifier and manual category selection take over, and push stays off.
