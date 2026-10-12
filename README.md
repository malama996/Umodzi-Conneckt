# Umodzi Connect — v0.1 / v0.2

This build follows the supplied implementation prompt and Theme B (Navy + Teal + Coral).

## Milestones
- **Version 0.1:** landing page, registration, login and manual matching.
- **Version 0.2:** technician profiles, skills and AI-assisted fault-classification baseline.

## Supplied image assets
- `frontend/public/images/landing-background-city.jpg` — landing-page background.
- `frontend/public/images/login-background-technician.jpg` — authentication background.
- `frontend/public/images/theme-reference.png` — Theme B visual reference.

## Run in VS Code

Requirements: Node.js 20.9+ and npm 10+.

Open the `umodzi-build` folder in VS Code, then:

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`.

To run the Fastify API in a second terminal:

```powershell
npm run dev -w backend
```

API health: `http://localhost:3001/health` (liveness) and
`http://localhost:3001/ready` (database readiness).

## Useful checks

```powershell
npm run typecheck -w frontend
npm run build -w frontend
npm run typecheck -w backend
```

## Main routes
- `/` — landing page
- `/login` — login
- `/register` — registration
- `/matching` — v0.1 manual matching + v0.2 classification
- `/technicians/Chanda%20M.` — v0.2 technician profile example

## Image configuration

The landing page background is configured in `frontend/lib/data.ts`:

```ts
export const landingPageConfig = {
  hero: {
    backgroundImage: '/images/landing-background-city.jpg',
    backgroundPosition: 'center center',
    overlayOpacity: 0.78,
  },
};
```

The authentication visual uses `frontend/public/images/login-background-technician.jpg`.

## Deployment

The Next.js frontend can be deployed to Netlify. The Fastify API needs a
separate Node host and managed PostgreSQL/PostGIS database. See
[`docs/NETLIFY_DEPLOYMENT.md`](docs/NETLIFY_DEPLOYMENT.md) for the required
environment variables and release checks.

The classification feature is a transparent keyword baseline and must not be
described as a trained AI model until it has a labelled dataset and evaluation.


## Theme B is canonical

Theme B is the live reusable Umodzi Connect design system, not inspiration. See `THEME-B-CANONICAL.md`. All future screens should reuse the same navy/teal/coral tokens, spacing, cards, controls, navigation, authentication composition and dashboard language.
