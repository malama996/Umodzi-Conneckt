'use client';

import { useEffect, useState } from 'react';

/**
 * Application-wide connection notice.
 *
 * The chat thread already reports its own transport state; every other surface
 * (dashboards, request forms, verification queues) had no way to tell the user
 * why a button had stopped responding. During a demonstration on venue Wi-Fi
 * that reads as a broken application rather than a dropped connection.
 *
 * Scope is deliberately narrow:
 *   - It reports the BROWSER's connectivity only (`navigator.onLine` and the
 *     online/offline events). It never claims that a request succeeded and it
 *     does not retry, queue or replay anything.
 *   - It is announced politely once, then stays visible while offline, so it
 *     cannot interrupt work or trap focus.
 *   - It renders nothing on a healthy connection, so first paint is unchanged.
 */
export default function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      You are offline. Pages you have already visited stay readable, but sending a message or
      request will wait until the connection returns.
    </div>
  );
}
