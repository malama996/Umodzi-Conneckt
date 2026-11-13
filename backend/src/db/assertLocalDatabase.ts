/**
 * Loopback-only guard for anything that writes schema or demo rows.
 *
 * On 13 November 2026 `backend/.env` supplied a hosted MIGRATIONS_DATABASE_URL
 * and one un-overridden invocation applied all twelve migrations to the live
 * database. Both the runner and the seeder check their connection host through
 * this function, and there is deliberately no environment variable that
 * disables the check.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertLocalDatabase(url: string | undefined, source: string, action: string): void {
  if (!url) return;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Refusing to ${action}: ${source} is not a valid connection URL.`);
  }

  if (!LOCAL_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `Refusing to ${action}: ${source} points at "${host}", which is not a local host.\n` +
        'Only loopback databases are permitted (localhost, 127.0.0.1, ::1).',
    );
  }
}
