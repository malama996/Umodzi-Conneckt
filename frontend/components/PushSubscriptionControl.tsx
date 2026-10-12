'use client';
import { useCallback, useEffect, useState } from 'react';
import { LuBell, LuBellOff } from 'react-icons/lu';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api/client';
import { deletePushSubscription, postPushSubscription } from '@/lib/api/pushApi';
import {
  forgetSubscriptionId,
  getBrowserSubscription,
  linkedSubscriptionId,
  pushCapability,
  pushPermission,
  rememberSubscriptionId,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
} from '@/lib/push/webPush';

type PushUiState =
  | 'checking'
  | 'signin'
  | 'unsupported'
  | 'not-configured'
  | 'denied'
  | 'off'
  | 'on'
  | 'working'
  | 'error';

/**
 * Browser push subscription control (Task 28.2C).
 *
 * Mounted on the dashboard (all roles, behind RequireAuth). "On" is shown
 * only when a browser subscription exists AND this device holds the backend
 * id from the registration response — never on a partial state. One
 * browser-local readiness check on mount; no polling, no extra network
 * calls until the user acts. Each device registers its own endpoint, so
 * other devices' subscriptions are never touched.
 */
export default function PushSubscriptionControl() {
  const { status: authStatus } = useAuth();
  const [state, setState] = useState<PushUiState>('checking');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus === 'loading') return;
    if (authStatus !== 'authenticated') {
      setState('signin');
      return;
    }
    const capability = pushCapability();
    if (capability === 'unsupported') {
      setState('unsupported');
      return;
    }
    if (capability === 'not-configured') {
      setState('not-configured');
      return;
    }
    if (pushPermission() === 'denied') {
      setState('denied');
      return;
    }
    let cancelled = false;
    void getBrowserSubscription()
      .then((subscription) => {
        if (cancelled) return;
        if (subscription && linkedSubscriptionId(subscription.endpoint)) {
          setState('on');
        } else {
          setState('off');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState('error');
          setMessage('Could not check the browser subscription.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  const fail = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.status === 401) {
      setMessage('Your session expired. Sign in again to manage notifications.');
    } else if (error instanceof Error && error.message) {
      setMessage(error.message);
    } else {
      setMessage(fallback);
    }
    setState('error');
  }, []);

  const enable = useCallback(async () => {
    setState('working');
    setMessage(null);
    try {
      const payload = await subscribeBrowserPush();
      const saved = await postPushSubscription(payload);
      rememberSubscriptionId(saved.endpoint, saved.id);
      setState('on');
    } catch (error) {
      fail(error, 'Could not enable notifications.');
    }
  }, [fail]);

  const disable = useCallback(async () => {
    setState('working');
    setMessage(null);
    try {
      const subscription = await getBrowserSubscription();
      if (!subscription) {
        setState('off');
        return;
      }
      const { endpoint } = subscription;
      const backendId = linkedSubscriptionId(endpoint);
      const removed = await unsubscribeBrowserPush();
      if (backendId) {
        try {
          await deletePushSubscription(backendId);
        } catch (error) {
          // Already gone server-side counts as gone — anything else is real.
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        forgetSubscriptionId(endpoint);
        setState('off');
        return;
      }
      // No backend id on this device: the browser subscription is removed,
      // but no server record is touched — it is never safe to guess one.
      void removed;
      setState('off');
      setMessage(
        'Browser notifications were turned off on this device. The matching server record could not be identified here, so nothing else was deleted.',
      );
    } catch (error) {
      fail(error, 'Could not turn off notifications.');
    }
  }, [fail]);

  return (
    <section className="push-section" aria-labelledby="push-heading">
      <div className="push-row">
        <div>
          <h2 id="push-heading">Browser notifications</h2>
          <p className="push-status" role="status">
            <PushStatusText state={state} message={message} />
          </p>
          <p className="push-note">Each device you enable is registered separately.</p>
        </div>
        <div className="push-actions">
          {(state === 'off' || state === 'error') && (
            <button type="button" className="button button-coral button-small" onClick={enable}>
              <LuBell size={14} aria-hidden="true" /> Enable notifications
            </button>
          )}
          {state === 'on' && (
            <button
              type="button"
              className="button push-button-secondary button-small"
              onClick={disable}
            >
              <LuBellOff size={14} aria-hidden="true" /> Turn off
            </button>
          )}
          {state === 'working' && (
            <button
              type="button"
              className="button push-button-secondary button-small"
              disabled
              aria-busy="true"
            >
              Working…
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function PushStatusText({ state, message }: { state: PushUiState; message: string | null }) {
  switch (state) {
    case 'checking':
      return <>Checking notification support…</>;
    case 'signin':
      return <>Sign in to manage notifications for this device.</>;
    case 'unsupported':
      return <>Push notifications are not supported in this browser.</>;
    case 'not-configured':
      return <>Push notifications are not available right now.</>;
    case 'denied':
      return (
        <>Notifications are blocked. Allow notifications in your browser settings to enable them.</>
      );
    case 'off':
      return <>Get notified on this device when your service updates.</>;
    case 'on':
      return <>Notifications are on for this device.</>;
    case 'working':
      return <>Working…</>;
    case 'error':
      return <>{message ?? 'Something went wrong.'}</>;
  }
}
