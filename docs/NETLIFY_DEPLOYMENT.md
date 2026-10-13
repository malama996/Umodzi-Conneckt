# Netlify deployment

Netlify hosts the Next.js frontend only. The Fastify API requires a separate
Node host with PostgreSQL/PostGIS; it cannot be deployed as this repository's
current Netlify frontend build.

## 1. Provision the API first

Deploy `backend` to a Node 20 host with persistent/managed PostgreSQL and the
PostGIS extension. Use `npm run build -w backend` as its build command and
`npm run start -w backend` as its start command. Configure its health check as
`GET /ready`.

Required production API environment values:

```text
NODE_ENV=production
DATABASE_URL=<managed Postgres/PostGIS connection string>
JWT_SECRET=<at least 32 random characters>
FRONTEND_ORIGIN=https://<your-netlify-site-or-custom-domain>
TRUST_PROXY=true
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
SEED_DEMO_DATA=false
```

If the API and frontend are on unrelated sites rather than sibling subdomains
of one custom domain, set `COOKIE_SAME_SITE=none`. Browser third-party-cookie
restrictions may still affect this design; use `app.example.com` and
`api.example.com` where possible.

Configure VAPID and an actual SMS provider before enabling those channels.
Do not use the mock SMS provider in production.

## 2. Deploy the frontend to Netlify

Connect this repository, use the repository root as the site directory, and
let `netlify.toml` supply the build settings. In Netlify's production
environment variables, set:

```text
NEXT_PUBLIC_API_BASE_URL=https://<api-domain>/api/v1
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<VAPID public key, if push is enabled>
```

`NEXT_PUBLIC_*` values are embedded at build time. Rebuild and deploy after
changing them. Never put database, JWT, VAPID private, SMS, or provider
credentials in Netlify frontend variables.

`netlify.toml` excludes only `NEXT_PUBLIC_API_BASE_URL` from Netlify's secrets
scanning because this public backend address is intentionally embedded in the
client bundle and can also appear in Next.js webpack cache files. Secrets
scanning remains enabled for other environment variables and files. This URL
must not contain credentials, API keys, tokens, or other sensitive information;
keep those on the backend rather than adding further scan exclusions or
disabling scanning.

## 3. Release verification

1. Request `https://<api-domain>/ready` and confirm `200`.
2. Confirm API CORS only returns the exact Netlify/custom frontend origin.
3. Register, log in, refresh the page, log out, and verify the secure refresh
   cookie works.
4. Upload and retrieve a verification document using production object storage
   before accepting real user documents.
5. Confirm that no demo technician records exist, and that production SMS and
   push use real credentials.
