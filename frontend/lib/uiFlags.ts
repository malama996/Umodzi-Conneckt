/**
 * Feature flags for the mobile-refinement rollout (§8 of the brief).
 *
 * `UI_V2` gates the NEW public-header mobile drawer (hamburger + slide-in
 * panel). The dashboard drawer refinement is a bugfix of behaviour that is
 * already in production and is therefore not flagged.
 *
 * Rollback without a code change: set NEXT_PUBLIC_UI_V2=false in the
 * Netlify build environment and redeploy — the site returns to the previous
 * public-header behaviour exactly (nav links hidden below the 950px
 * breakpoint, no hamburger). Default is ON.
 */
export const UI_V2 = process.env.NEXT_PUBLIC_UI_V2 !== 'false';
