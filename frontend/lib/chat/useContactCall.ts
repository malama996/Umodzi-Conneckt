import { useCallback, useRef, useState } from 'react';

import { ApiError, get } from '@/lib/api/client';
import { toTelLink } from '@/lib/api/communicationApi';

/**
 * Contact/call state machine (Task 33.4).
 *
 * One shared implementation for both contact surfaces (conversation list
 * and chat thread): fetch the OTHER participant's authorized number from
 * `GET /requests/:id/contact`, then either hand it to the device dialer
 * (coarse-pointer/mobile) or show it as text with a copy action
 * (desktop). The backend is the only source of a number — nothing is
 * ever invented locally, and a 404 is surfaced as an honest "no contact
 * number" message instead of a broken link.
 */
export type ContactCallState =
  | { status: 'idle' }
  | { status: 'working'; label: string | null }
  | {
      status: 'ready';
      label: string | null;
      phone: string;
      tel: string;
      copied: boolean;
      copyError: string | null;
    }
  | { status: 'unavailable'; label: string | null; message: string }
  | { status: 'error'; label: string | null; message: string };

const UNAVAILABLE_MESSAGE = 'No contact number is available for this participant yet.';
const FAILURE_MESSAGE = 'Could not open the contact action right now.';
const COPY_FAILURE_MESSAGE = 'Could not copy automatically — select the number to copy it.';

/** True on touch-first devices, where `tel:` opens the phone dialer. */
function canAutoDial(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

export function useContactCall(defaultRequestId?: string | null) {
  const [state, setState] = useState<ContactCallState>({ status: 'idle' });
  // Synchronous re-entry guard: a double-click before the re-render that
  // shows the working state must not fire two lookups.
  const busyRef = useRef(false);

  const call = useCallback(
    async (options?: { requestId?: string; label?: string | null }) => {
      const requestId = options?.requestId ?? defaultRequestId ?? undefined;
      const label = options?.label ?? null;
      if (!requestId || busyRef.current) return;
      busyRef.current = true;
      setState({ status: 'working', label });
      try {
        const body = await get<{ data?: { phone?: string | null; tel?: string } }>(
          `/requests/${requestId}/contact`,
        );
        const phone = body.data?.phone;
        if (!phone) {
          setState({ status: 'unavailable', label, message: UNAVAILABLE_MESSAGE });
          return;
        }
        const tel = toTelLink(phone);
        setState({ status: 'ready', label, phone, tel, copied: false, copyError: null });
        // Mobile: the same authorized number initiates the call directly.
        // Desktop keeps the visible panel (number + copy) — we never fire
        // a `tel:` navigation that would silently do nothing there.
        if (canAutoDial()) window.location.href = tel;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: 'unavailable', label, message: UNAVAILABLE_MESSAGE });
        } else {
          setState({ status: 'error', label, message: FAILURE_MESSAGE });
        }
      } finally {
        busyRef.current = false;
      }
    },
    [defaultRequestId],
  );

  const copy = useCallback(async (phone: string) => {
    try {
      await navigator.clipboard.writeText(phone);
      setState((prev) =>
        prev.status === 'ready' ? { ...prev, copied: true, copyError: null } : prev,
      );
    } catch {
      setState((prev) =>
        prev.status === 'ready'
          ? { ...prev, copied: false, copyError: COPY_FAILURE_MESSAGE }
          : prev,
      );
    }
  }, []);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, call, copy, reset };
}
