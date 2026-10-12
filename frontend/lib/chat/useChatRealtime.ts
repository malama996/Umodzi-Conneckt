'use client';

import { useEffect, useRef, useState } from 'react';

import { getAccessToken } from '@/lib/auth/tokenHolder';
import type { ChatRealtimeEvent } from '@/lib/types/communication';

/**
 * Realtime chat transport (Task 28.4B — client side).
 *
 * Design constraints, in order:
 *   1. Authoritative persistence stays HTTP. This hook carries EVENTS ONLY;
 *      a lost, dropped or duplicated event never loses a message, because the
 *      message already exists in PostgreSQL and is re-fetched on reconnect.
 *   2. The handshake carries the session token as a WebSocket subprotocol
 *      (the same mechanism browsers permit for upgrades), so the server
 *      authenticates and authorizes before the connection is accepted.
 *   3. The client subscribes ONLY to the active conversation. The server
 *      re-checks authorization on its side, so this is a UI optimisation,
 *      never a security boundary.
 *   4. There is no polling and no message simulation. If the socket cannot
 *      open, the caller is told and keeps using REST.
 *
 * Cleanup: the effect closes the socket on unmount or conversation change.
 * No interval, no retry loop, no unbounded queue.
 */

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

interface UseChatRealtimeOptions {
  conversationId: string | null;
  /** Called for every message event that belongs to the active conversation. */
  onMessage: (messageId: string, conversationId: string) => void;
  /**
   * Called after a RE-connect is authorized (subscribed), never on the first
   * connection. Events are only ids, so anything sent while the socket was
   * down was never seen — the caller should re-read history over REST and
   * merge by stable message id (Task 33.3 catch-up contract).
   */
  onReconnect?: () => void;
  /** Called for authorization/transport errors so the UI can react. */
  onError?: (reason: string) => void;
  enabled?: boolean;
}

/** Derive the realtime endpoint from the configured API base. */
function realtimeUrl(): string {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  try {
    const url = new URL(apiBase);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}/api/v1/realtime`;
  } catch {
    // Relative dev deployment: same host, same protocol family.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api/v1/realtime`;
  }
}

export function useChatRealtime({
  conversationId,
  onMessage,
  onReconnect,
  onError,
  enabled = true,
}: UseChatRealtimeOptions): { status: RealtimeStatus } {
  const [status, setStatus] = useState<RealtimeStatus>('offline');
  // Latest callbacks in refs so the socket effect never has to re-run just
  // because a handler identity changed (avoids accidental reconnect loops).
  const onMessageRef = useRef(onMessage);
  const onReconnectRef = useRef(onReconnect);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onMessageRef.current = onMessage;
    onReconnectRef.current = onReconnect;
    onErrorRef.current = onError;
  }, [onMessage, onReconnect, onError]);

  const stableConversation = conversationId;

  useEffect(() => {
    if (!enabled || !stableConversation) {
      setStatus('offline');
      return;
    }
    const token = getAccessToken();
    if (!token) {
      setStatus('offline');
      return;
    }

    let socket: WebSocket | null = null;
    let closedByUs = false;
    // Which attempt this is: catch-up only fires from the second onwards,
    // so the FIRST connection never triggers a redundant history refetch.
    let connectCount = 0;

    const connect = () => {
      setStatus((prev) => (prev === 'offline' ? 'connecting' : 'reconnecting'));
      try {
        socket = new WebSocket(realtimeUrl(), [`bearer-${token}`]);
      } catch {
        // No realtime transport available (e.g. server without `ws`).
        setStatus('offline');
        return;
      }

      socket.onopen = () => {
        connectCount += 1;
        setStatus('connected');
        socket?.send(JSON.stringify({ subscribe: { conversationId: stableConversation } }));
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return; // malformed event is ignored, never crashes the UI
        }
        const data = payload as Partial<ChatRealtimeEvent> & { error?: string };
        if (
          data.type === 'message' &&
          data.conversationId === stableConversation &&
          data.messageId
        ) {
          onMessageRef.current(data.messageId, stableConversation);
          return;
        }
        if (data.type === 'subscribed' && connectCount > 1) {
          // Authorized again after a reconnect: anything sent while the
          // socket was down never produced an event here, so ask the caller
          // to re-read history over REST (merge by stable id → no dupes).
          onReconnectRef.current?.();
          return;
        }
        if (data.type === 'error' && data.error) {
          // An explicit authorization error means stop trying.
          if (/not authorized|not found|Authentication/i.test(data.error)) {
            closedByUs = true;
            socket?.close();
            setStatus('offline');
          }
          onErrorRef.current?.(data.error);
        }
      };

      socket.onclose = () => {
        if (closedByUs) return;
        // A single, clean reconnect attempt — not an aggressive loop. After
        // that the transport reports offline and REST remains authoritative.
        setStatus('reconnecting');
        window.setTimeout(() => {
          if (!closedByUs && document.visibilityState !== 'hidden') {
            connect();
          } else {
            setStatus('offline');
          }
        }, 1500);
      };

      socket.onerror = () => {
        if (!closedByUs) setStatus('reconnecting');
      };
    };

    connect();

    return () => {
      closedByUs = true;
      if (socket && socket.readyState <= WebSocket.OPEN) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
    };
  }, [enabled, stableConversation]);

  return { status };
}
