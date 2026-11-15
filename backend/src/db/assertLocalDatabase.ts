/**
 * Loopback-only guard for anything that writes schema or demo rows.
 *
 * This protection applies to manual seed/demo commands only. Those commands
 * must never write to a hosted database. The API migration runner is separate:
 * it runs as part of the controlled deployment startup sequence with a
 * dedicated administrative connection and an advisory lock.
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
