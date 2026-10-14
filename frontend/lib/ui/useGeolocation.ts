'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isValidMapPoint, type MapPoint } from '@/lib/mapData';

/**
 * On-demand browser geolocation for the map (production-fix Task 5).
 *
 * ---------------------------------------------------------------------------
 * Privacy and honesty rules this hook exists to enforce
 * ---------------------------------------------------------------------------
 *   * It NEVER runs on mount. The browser permission prompt is opened only
 *     when the person taps a control that says what it is for, because a
 *     prompt that appears by itself is how location access gets denied for
 *     good — and Android/Chrome will not ask twice.
 *   * It NEVER watches. `getCurrentPosition` is a single fix, and there is no
 *     `watchPosition` anywhere: once the position is read (or the caller
 *     clears it) tracking stops. No position is sent anywhere by this hook —
 *     it hands the coordinate to the calling component, which draws it.
 *   * It NEVER substitutes a guessed position. Every failure mode has its own
 *     state, and the coordinate stays null. A caller that needs a marker when
 *     the fix fails must say explicitly that it is showing something coarser
 *     (the request city) and label it as such — this hook will not do it
 *     silently.
 *   * Coordinates are validated as real WGS84 degrees before being returned,
 *     so a malformed/absurd value (0,0 placeholder, latitude 900) can never
 *     reach the map or the dispatch path.
 */

export type GeolocationStatus =
  | 'idle'
  /** A fix is being requested right now. */
  | 'locating'
  | 'granted'
  /** Permission refused by the person (or by a prior "don't allow"). */
  | 'denied'
  /** Positioning is switched off device-wide, or no provider is available. */
  | 'unavailable'
  /** The provider took too long to answer. */
  | 'timeout'
  /** No Geolocation API at all (old browser, or a non-secure origin). */
  | 'unsupported';

export interface GeolocationState {
  status: GeolocationStatus;
  /** The real position, or null whenever there is no usable fix. */
  position: MapPoint | null;
  /** Non-technical explanation of the current state. */
  message: string;
}

const MESSAGES: Record<GeolocationStatus, string> = {
  idle: 'Your map marker is centred on the service area you chose. Share your location to place it on your real position.',
  locating: 'Getting your location…',
  granted: 'Showing your device location.',
  denied:
    'Location permission was blocked, so the map is centred on the service area instead. You can allow location for this site in your browser settings and try again.',
  unavailable:
    'Your device could not provide a location. The map is centred on the service area instead.',
  timeout: 'Your location took too long to arrive. The map is centred on the service area instead.',
  unsupported:
    'This browser cannot share a location. The map is centred on the service area instead.',
};

/** Map a GeolocationPositionError onto our states (never onto a fake fix). */
function statusForError(error: GeolocationPositionError): GeolocationStatus {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'denied';
    case error.POSITION_UNAVAILABLE:
      return 'unavailable';
    case error.TIMEOUT:
      return 'timeout';
    default:
      return 'unavailable';
  }
}

const FIX_TIMEOUT_MS = 12_000;

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    position: null,
    message: MESSAGES.idle,
  });
  // Guards a late callback from a previous request overwriting a newer state.
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Invalidate any in-flight request so its callback is ignored.
      requestSeq.current += 1;
    };
  }, []);

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'unsupported', position: null, message: MESSAGES.unsupported });
      return;
    }
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setState({ status: 'locating', position: null, message: MESSAGES.locating });

    navigator.geolocation.getCurrentPosition(
      (result) => {
        if (!mounted.current || requestSeq.current !== seq) return;
        const point: MapPoint = {
          latitude: result.coords.latitude,
          longitude: result.coords.longitude,
        };
        if (!isValidMapPoint(point)) {
          // A provider that answers with an out-of-range coordinate is a
          // failure, not a location: report it rather than draw a marker.
          setState({ status: 'unavailable', position: null, message: MESSAGES.unavailable });
          return;
        }
        setState({ status: 'granted', position: point, message: MESSAGES.granted });
      },
      (error) => {
        if (!mounted.current || requestSeq.current !== seq) return;
        const status = statusForError(error);
        setState({ status, position: null, message: MESSAGES[status] });
      },
      { enableHighAccuracy: false, timeout: FIX_TIMEOUT_MS, maximumAge: 60_000 },
    );
  }, []);

  /** Forget the fix — the caller falls back to its declared service area. */
  const clear = useCallback(() => {
    requestSeq.current += 1;
    setState({ status: 'idle', position: null, message: MESSAGES.idle });
  }, []);

  return { ...state, request, clear };
}
