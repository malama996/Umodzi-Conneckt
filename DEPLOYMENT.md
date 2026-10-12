# Umodzi Connect — Deployment Guide (Task 36)

This guide walks you through deploying Umodzi Connect to production using GitHub, Render, and Netlify.

## Architecture Overview

```
┌─────────────┐         ┌──────────────┐         ┌─────────────────┐
│   Netlify   │────────▶│    Render    │────────▶│  Supabase/      │
│  Frontend   │  HTTPS  │   Backend    │  HTTPS  │  PostgreSQL     │
│  (Next.js)  │◀────────│  (Fastify +  │◀────────│  (PostGIS)      │
└─────────────┘  CORS   │   WebSocket) │         └─────────────────┘
                        └──────────────┘
```

- **Frontend**: Next.js 15 App Router with SSR, deployed on Netlify
- **Backend**: Fastify 5 API + WebSocket realtime, deployed on Render
- **Database**: PostgreSQL 16 + PostGIS 3.4 (Supabase recommended)
- **CI/CD**: GitHub Actions for validation, manual deployment

---

## A. GitHub Setup

### 1. Create Private Repository

```bash
cd "C:\Users\ARNOLD MALAMA\OneDrive\Desktop\umodzi-build"
git init
git add .
git commit -m "Initial commit: V0.2 complete + Task 36 deployment prep"
```

### 2. Review Changes Before Pushing

```bash
# Check what will be committed
git status
git diff --cached

# Verify no secrets are tracked
git ls-files | grep -E "\.env$|\.pem$|\.key$"
# Should return nothing
```

### 3. Confirm .gitignore is Working

The following files are **excluded** from Git:
- `.env`, `.env.*` (except `.env.example`)
- `backend/.env`, `frontend/.env.local`
- `node_modules/`, `frontend/.next/`, `backend/dist/`
- `backend/var/uploads/` (uploaded files)

### 4. Push to GitHub

```bash
# Create repository on GitHub (private)
# Then:
git remote add origin git@github.com:YOUR_USERNAME/umodzi-connect.git
git branch -M main
git push -u origin main
```

### 5. Branch Strategy

- **`main`**: Production branch (stable, tested)
- **`staging`**: Pre-production testing (optional)
- **Feature branches**: Development work → PR to staging/main

```bash
git checkout -b staging
git push -u origin staging
```

---

## B. Database Configuration

### Recommended: Supabase PostgreSQL/PostGIS

1. **Create Supabase Project** at https://supabase.com
2. **Enable PostGIS Extension**:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```
3. **Create Restricted Runtime Role** (`umodzi_app`):
   ```sql
   CREATE ROLE umodzi_app LOGIN PASSWORD 'strong-password-here';
   GRANT CONNECT ON DATABASE postgres TO umodzi_app;
   GRANT USAGE ON SCHEMA public TO umodzi_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO umodzi_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO umodzi_app;
   ```
4. **Get Connection Strings**:
   - **Runtime** (`DATABASE_URL`): Use pooler connection with `umodzi_app` role
     ```
     postgresql://umodzi_app:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=verify-full
     ```
   - **Migrations** (`MIGRATIONS_DATABASE_URL`): Use direct connection with admin role
     ```
     postgresql://postgres:ADMIN_PASSWORD@db.region.supabase.co:5432/postgres?sslmode=verify-full
     ```

### SSL Certificate Verification

For `sslmode=verify-full`, download Supabase CA certificate:
```bash
curl -o backend/ca-cert.crt https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

Then update `DATABASE_URL`:
```
postgresql://user:pass@host:port/db?sslmode=verify-full&sslrootcert=./ca-cert.crt
```

### Migration Strategy

**DO NOT** run migrations on every restart in production. Instead:

```bash
# Manual migration (recommended for production)
npm run migrate -w backend

# Or via Render deploy hook (see Phase C)
```

---

## C. Render Configuration

### 1. Create Web Service

- **Service Type**: Web Service
- **Environment**: Node
- **Root Directory**: `.` (repository root)
- **Branch**: `main` (or `staging` for testing)

### 2. Build & Start Commands

- **Build Command**: `npm ci && npm run build -w backend`
- **Start Command**: `npm run start -w backend`

> **Note**: Migrations should be run manually or via a separate deploy hook, not on every start. The `render.yaml` includes migrations in the start command for convenience, but this is **not recommended** for production.

### 3. Health Check Path

- **Path**: `/health`
- **Port**: Auto-detected from `PORT` env var

### 4. Environment Variables (Set in Render Dashboard)

| Variable | Value | Sensitive? |
|----------|-------|------------|
| `NODE_ENV` | `production` | No |
| `DATABASE_URL` | `postgresql://umodzi_app:...` | **YES** |
| `MIGRATIONS_DATABASE_URL` | `postgresql://postgres:...` | **YES** |
| `JWT_SECRET` | Generate: `openssl rand -hex 32` | **YES** |
| `FRONTEND_ORIGIN` | `https://your-app.netlify.app` | No |
| `ADMIN_EMAIL` | `admin@yourdomain.com` | **YES** |
| `ADMIN_PASSWORD` | Strong password | **YES** |
| `STORAGE_DIR` | `var/uploads` | No |
| `TRUST_PROXY` | `true` | No |
| `COOKIE_SECURE` | `true` | No |
| `COOKIE_SAME_SITE` | `none` (if cross-domain) | No |

### Optional Environment Variables

- **SMS** (Africa's Talking): `SMS_PROVIDER`, `AFRICASTALKING_USERNAME`, `AFRICASTALKING_API_KEY`
- **AI Classification**: `GEMINI_API_KEY`
- **Web Push**: `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`

### 5. WebSocket Support

Render supports WebSockets natively. The backend upgrade handler is already configured at `/api/v1/realtime`. No additional configuration needed.

### 6. Free Tier Limitations

- **Spin-down**: Services sleep after 15 minutes of inactivity
- **Wake-up time**: ~30-60 seconds on first request
- **Keep-alive**: GitHub Actions workflow attempts to ping every 10 minutes (best-effort only)

---

## D. Netlify Configuration

### 1. Connect Repository

- Go to https://app.netlify.com
- Click "Add new site" → "Import an existing project"
- Select your GitHub repository
- **Base directory**: Leave blank (monorepo root)
- **Build command**: `npm ci && npm run build -w frontend`
- **Publish directory**: `frontend/.next`

### 2. Install Netlify Plugin

Netlify will automatically detect `netlify.toml` and install `@netlify/plugin-nextjs`.

### 3. Environment Variables (Set in Netlify Dashboard)

| Variable | Value | Sensitive? |
|----------|-------|------------|
| `NODE_VERSION` | `20` | No |
| `NEXT_PUBLIC_API_BASE_URL` | `https://your-backend.onrender.com/api/v1` | No |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | From backend VAPID setup | No |

> **Important**: `NEXT_PUBLIC_*` variables are baked into the build at compile time. You must **redeploy** after changing them.

### 4. Domain & HTTPS

- Netlify provides free HTTPS on `*.netlify.app` subdomains
- Custom domains supported with automatic certificate renewal

### 5. Cookie Authentication Across Domains

Since frontend (Netlify) and backend (Render) are on different domains:

- Backend sets `FRONTEND_ORIGIN=https://your-app.netlify.app`
- CORS `credentials: true` allows HttpOnly cookies
- Set `COOKIE_SAME_SITE=none` in backend environment
- Ensure both sites use HTTPS (required for cross-site cookies)

---

## E. GitHub Actions

### 1. Enable Workflows

Workflows are in `.github/workflows/`:
- **`ci.yml`**: Runs on push/PR to `main`/`staging`
  - Typecheck, lint, build both workspaces
  - Run unit tests with isolated test database
  - Never uses production credentials

- **`render-keepalive.yml`**: Scheduled every 10 minutes
  - Pings Render health endpoint
  - Prevents free-tier spin-down (best-effort)
  - Manual trigger available

### 2. Configure Repository Variable

Go to **Settings → Secrets and variables → Actions → Variables**:

- Add variable: `RENDER_HEALTH_URL`
- Value: `https://your-backend.onrender.com/health`

### 3. Trigger Keep-Alive Manually

Go to **Actions → Render Keep-Alive → Run workflow**

### 4. Diagnose CI Failures

- Check the "Actions" tab in your repository
- Click on failed workflow run
- Expand job steps to see error messages
- Fix issues locally, commit, and push again

---

## F. Manual Acceptance Checklist

After deployment, verify these features work in production:

### Authentication & Authorization
- [ ] Customer registration and login
- [ ] Technician registration and login
- [ ] Administrator login (seeded account)
- [ ] Session persistence across page reloads
- [ ] Logout clears session properly
- [ ] Role-based access control (customer can't access technician pages, etc.)

### Core Features
- [ ] Fault classification (keyword-based + manual fallback)
- [ ] Service request creation with review step
- [ ] Smart Dispatch matching (eligible technicians ranked)
- [ ] Map visualization with markers and popups
- [ ] Technician offer acceptance/rejection
- [ ] Request lifecycle transitions (pending → matching → matched/completed)

### Realtime Communication
- [ ] Chat messages deliver in real-time via WebSocket
- [ ] Reconnect recovery without duplicate messages
- [ ] Conversation privacy (only participants can read)
- [ ] Administrator restrictions (can't read private conversations)

### Notifications
- [ ] In-app notifications appear for new offers/messages
- [ ] Push subscription works (if VAPID configured)
- [ ] Contact/call functionality (phone links)

### Admin & Reputation
- [ ] Admin dashboard shows real metrics
- [ ] User management (activate/suspend accounts)
- [ ] Technician verification workflow
- [ ] Ratings and reviews for completed services
- [ ] Audit log accessible to administrators

### Legal & Compliance
- [ ] Terms page renders correctly
- [ ] Privacy policy page renders correctly
- [ ] Data export endpoint works (`GET /api/v1/me/data`)
- [ ] Account deletion works with proper cleanup

### Mobile & Performance
- [ ] Responsive design at 390px, 768px, 1024px, 1440px
- [ ] No horizontal overflow on any screen size
- [ ] Production assets load (images, icons, fonts)
- [ ] PWA manifest serves correctly
- [ ] Service worker registers in production

### Infrastructure
- [ ] Health endpoint returns 200: `https://your-backend.onrender.com/health`
- [ ] Ready endpoint confirms DB connectivity: `/ready`
- [ ] Database persists data across backend restarts
- [ ] File uploads work (profile photos, verification documents)
- [ ] CI workflows pass on push

---

## Known Limitations

### Render Free Tier
- Services spin down after 15 minutes of inactivity
- First request after spin-down takes 30-60 seconds
- Keep-alive workflow is best-effort (GitHub may delay scheduled runs)
- No guarantee of 24/7 uptime

### Database
- Supabase free tier has connection limits
- Pooler recommended for production (reduces connection count)
- No automated backups on free tier

### Testing
- CI uses isolated test database, not production data
- Some tests may be skipped if prerequisites unavailable (documented in CI logs)
- Live deployment verification requires manual testing

---

## Troubleshooting

### Frontend Can't Connect to Backend
- Verify `NEXT_PUBLIC_API_BASE_URL` is set correctly in Netlify
- Check browser console for CORS errors
- Ensure `FRONTEND_ORIGIN` matches your Netlify domain exactly
- Verify backend is running (check Render logs)

### Authentication Fails
- Check `JWT_SECRET` is set and ≥32 characters
- Verify `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none` for cross-domain
- Check browser DevTools → Application → Cookies for cookie presence
- Ensure HTTPS is enabled on both frontend and backend

### Database Connection Fails
- Verify `DATABASE_URL` format includes `?sslmode=verify-full`
- Check Supabase dashboard for connection limits
- Test connection string locally: `psql "YOUR_DATABASE_URL"`
- Check Render logs for detailed error messages

### WebSocket Disconnections
- Verify Render supports WebSocket upgrade (it does by default)
- Check browser console for WebSocket errors
- Ensure `/api/v1/realtime` path is not blocked by firewall
- Verify authentication token is valid

---

## Next Steps After Deployment

1. **Monitor Logs**: Check Render dashboard for error patterns
2. **Set Up Alerts**: Configure Render email alerts for crashes
3. **Backup Database**: Enable Supabase automated backups (paid tier)
4. **Custom Domain**: Point your own domain to Netlify
5. **Performance Monitoring**: Add application performance monitoring (APM)
6. **Error Tracking**: Integrate Sentry or similar for error reporting
7. **Upgrade Plan**: Consider Render paid tier for always-on service

---

**Last Updated**: 2026-10-10 (Task 36)
**Repository State**: V0.2 complete, deployment-ready
