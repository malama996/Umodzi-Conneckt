# Umodzi Connect — Postman test suite

A runnable smoke suite for the backend API. It walks one complete customer journey plus the
administration endpoints, and asserts the status code and a few fields at every step.

`Umodzi-Connect-API.postman_collection.json` — the collection
`Umodzi-Connect-Local.postman_environment.json` — the matching environment

## Before you run

1. A database that is migrated and seeded:
   ```bash
   npm run migrate -w backend
   npm run seed -w backend
   ```
2. The API running on port 3001 with a local database:
   ```bash
   PORT=3001 npm run dev -w backend
   ```
3. `ADMIN_EMAIL` / `ADMIN_PASSWORD` must match the environment file. The defaults used by the
   local setup are `admin@umodzi.test` and `LocalTestAdmin2026!`.

## Run it in Postman

1. Import both JSON files (File → Import).
2. Select **Umodzi Connect — Local** in the environment selector (top right).
3. Run the collection top to bottom — Collection → Run, or open each request in order.
   **Order matters**: each step saves the ids and tokens the next one reads.

## Run it headless

```bash
npx --yes newman run postman/Umodzi-Connect-API.postman_collection.json \
  -e postman/Umodzi-Connect-Local.postman_environment.json
```

Expected result: **28 assertions, 0 failures**. Verified against a freshly migrated and seeded
local database.

## What it covers

| Folder | Steps |
|---|---|
| 0. Health | `/health` |
| 1. Authentication | admin login, register customer, register technician, both logins, `me`, refresh, unauthenticated `me` → 401 |
| 2. Catalogue | categories (nine), technician list, nearby search, classification of a fault description |
| 3. Requests and offers | create request, read it back, non-participant gets 404, dispatch offer exists, duplicate offer → 409, invalid status → 400 |
| 4. Notifications and chat | list notifications, mark all read, my conversations, send a message |
| 5. Administration | overview, user list (asserts no `password_hash` leaks), technician list, non-admin → 403, audit trail |
| 6. Cleanup | customer logout |

## Notes

- Emails are generated per run (`customer{{$timestamp}}@umodzi.test`), so repeat runs do not collide.
- `clientRequestId` is a UUID (`{{$guid}}`); the API rejects anything else with 400.
- A request created through the API is dispatched automatically, which is why the suite asserts
  that an offer already exists and that a second manual offer returns 409 rather than 201.
- The login endpoint is rate limited (20 per minute). Running the collection repeatedly in quick
  succession can return 429; wait a minute or restart the API.
- Requests created by the suite remain in the database. Re-seed or recreate `umodzi_test` for a
  clean baseline.
