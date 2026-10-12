# Umodzi Connect — Theme B Canonical Design System

Theme B (Navy + Teal + Coral) is the **live, reusable product design system** for Umodzi Connect. The supplied Theme B reference is treated as the visual specification, not merely inspiration.

## Canonical assets
- `frontend/public/images/landing-background-city.jpg` — full landing-page background and reusable city visual.
- `frontend/public/images/login-background-technician.jpg` — authentication visual for login and registration.
- `frontend/public/images/theme-reference.png` — retained visual specification reference.

## Canonical rules
- Navy establishes brand structure and navigation.
- Teal establishes interaction, location, progress and selected states.
- Coral is reserved for primary calls to action and important highlights.
- Cards, forms, buttons, badges, navigation, spacing and typography must use the shared Theme B tokens in `frontend/app/globals.css`.
- New pages must use the reusable components in `frontend/components/ui.tsx` rather than inventing a separate visual language.
- The landing hero must retain the reference composition: dark left text field, photographic right side, location/service cues, teal/coral curved accents and coral primary CTA.
- Authentication must retain the reference split-screen composition with the technician image and Theme B form treatment.
- Dashboard, matching, profiles and future modules must remain recognizably part of the same Theme B system.

## Current routes
- `/` — Theme B landing page
- `/login` — Theme B authentication
- `/register` — Theme B registration
- `/dashboard` — Theme B consumer dashboard shell
- `/matching` — v0.1 manual matching + v0.2 AI-assisted classification baseline
- `/technicians/Chanda%20M.` — v0.2 technician profile
