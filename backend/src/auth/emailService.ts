/**
 * Email delivery via the Resend HTTP API (audit §3 — password recovery).
 *
 * Dependency-free: uses the global fetch available in Node 20+. No SDK is
 * added to the project. Secrets stay server-side:
 *   - RESEND_API_KEY    — bearer token, never exposed to the frontend;
 *   - RESEND_FROM_EMAIL — the verified sender address;
 *   - FRONTEND_ORIGIN (or PUBLIC_APP_URL) — frontend origin used to build
 *     the recovery link. FRONTEND_ORIGIN is the existing canonical value
 *     (CORS allow-list); PUBLIC_APP_URL is accepted as an alias.
 *
 * Failure policy: sending email must never crash a request or become a
 * side channel. Every failure is logged and reported as `false`; the
 * recovery endpoint answers identically whether or not delivery succeeded.
 *
 * When Resend is NOT configured (no API key) the message is not sent. To
 * keep local development usable, in NON-production only the recovery link
 * is printed to the server console so a developer can complete the flow.
 * The link is NEVER logged in production and NEVER returned in a response.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function resetLink(rawToken: string): string {
  const origin =
    process.env.FRONTEND_ORIGIN ??
    process.env.PUBLIC_APP_URL ??
    'http://localhost:3000';
  const base = origin.replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Send the password-recovery email. Returns true only when Resend accepted
 * the message. Builds the link from PUBLIC_APP_URL + the raw single-use
 * token (the token itself is never persisted in raw form anywhere).
 */
export async function sendPasswordResetEmail(
  to: string,
  rawToken: string,
): Promise<boolean> {
  const link = resetLink(rawToken);

  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      // Developer affordance only. Gated behind non-production so a missing
      // key can never leak a live reset link into production logs.
      console.warn(
        `[email] Resend not configured (set RESEND_API_KEY + RESEND_FROM_EMAIL).\n` +
          `[email] Local password-reset link for ${to}:\n${link}`,
      );
    }
    return false;
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0B1F3A;max-width:520px;margin:0 auto;">
      <h2 style="color:#0B1F3A;">Reset your Umodzi Connect password</h2>
      <p>We received a request to reset your password. Use the button below to choose a new one.</p>
      <p style="margin:24px 0;">
        <a href="${link}"
           style="background:#0F9D8A;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;">
          Reset password
        </a>
      </p>
      <p style="font-size:13px;color:#5a6e7d;">
        This link is single-use and expires shortly. If you did not request a reset,
        you can safely ignore this email — your password will not change.
      </p>
      <p style="font-size:12px;color:#5a6e7d;word-break:break-all;">
        Button not working? Paste this into your browser:<br/>${link}
      </p>
    </div>`;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: [to],
        subject: 'Reset your Umodzi Connect password',
        html,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[email] Resend rejected the message (${response.status}): ${detail}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[email] Failed to send password-reset email:', error);
    return false;
  }
}
