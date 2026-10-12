'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  LuArrowLeft,
  LuMessageSquare,
  LuPhone,
  LuRefreshCw,
  LuSendHorizontal,
  LuCheck,
  LuCheckCheck,
} from 'react-icons/lu';

import { useAuth } from '@/lib/auth';
import {
  communicationErrorMessage,
  getConversationMessages,
  resolveConversation,
  markConversationRead,
  sendConversationMessage,
} from '@/lib/api/communicationApi';
import type { ConversationDetail } from '@/lib/types/communication';
import { useChatRealtime } from '@/lib/chat/useChatRealtime';
import { useContactCall } from '@/lib/chat/useContactCall';
import ContactCallPanel from '@/components/ContactCallPanel';
import RequireAuth from '@/components/RequireAuth';
import { DashboardLayout } from '@/components/ui';
import '../chat.css';

/** Kept in sync with the server's `chk_messages_length` maximum. */
const MAX_MESSAGE_LENGTH = 2000;
const PAGE_SIZE = 30;

/** Local-only delivery state for a message the user just sent. */
type DeliveryState = 'sending' | 'sent' | 'failed';

interface DisplayMessage {
  id: string;
  senderId: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  /** Only set for optimistic rows awaiting the server's authoritative id. */
  pending?: DeliveryState;
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, TIME_FORMAT);
}

/** Stable local-day key used for day dividers and message grouping. */
function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Human day label: "Today" / "Yesterday" / a readable date. Empty if invalid. */
function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function mergeById(current: DisplayMessage[], incoming: DisplayMessage[]): DisplayMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    // A realtime echo of a message we already hold wins only if it can
    // upgrade the local optimistic row to its server identity.
    if (existing && existing.pending) byId.set(message.id, { ...message });
    else if (!existing) byId.set(message.id, message);
    else if (message.readAt && !existing.readAt)
      byId.set(message.id, { ...existing, readAt: message.readAt });
  }
  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Conversation thread route.
 *
 * Phase 2: gated by RequireAuth like every other dashboard route. The
 * anonymous branch below used to be this page's only guard, which meant
 * the route rendered its own bespoke "Sign in" panel instead of the
 * application-wide /login?next=… redirect — and, while the session was
 * still resolving, an unauthenticated visitor could see the chat shell.
 */
export default function ChatPage() {
  return (
    <RequireAuth>
      <ConversationThread />
    </RequireAuth>
  );
}

function ConversationThread() {
  const params = useParams();
  const router = useRouter();
  const { status: authStatus, user } = useAuth();

  // The route carries a REQUEST id; the conversation is resolved from it.
  const requestId = typeof params.conversationId === 'string' ? params.conversationId : '';

  // Session identity: the only source of "am I the sender?" for a row.
  const authUserId = user?.id ?? null;

  const [state, setState] = useState<'loading' | 'unavailable' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  /** How many messages arrived while the reader was away from the bottom. */
  const [newCount, setNewCount] = useState(0);
  // Contact/call (Task 33.4): fetch → tel: link + visible number/copy.
  const contact = useContactCall(detail?.conversation.serviceRequestId ?? null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const atBottomRef = useRef(true);
  const lastMarkedReadRef = useRef<string | null>(null);
  /**
   * Timestamp of the newest message in the FIRST loaded page. Messages newer
   * than this are "fresh" and get the arrival animation; the loaded history
   * never replays it after a refresh. Server timestamps on both sides of the
   * comparison keep this clock-skew independent.
   */
  const historyMaxRef = useRef<number>(0);
  /** Newest id at the previous effect run — used to count late arrivals. */
  const newestIdRef = useRef<string | null>(null);

  /* ---------------- conversation + first page ---------------- */

  useEffect(() => {
    if (authStatus === 'anonymous') return;
    let cancelled = false;
    setState('loading');
    setError(null);
    void (async () => {
      try {
        const conversation = await resolveConversation(requestId);
        if (cancelled) return;
        if (!conversation) {
          setState('unavailable');
          return;
        }
        setDetail(conversation);
        const page = await getConversationMessages(conversation.conversation.id, {
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        // Watermark for the arrival animation: everything already on the
        // server is history; only messages newer than this are "new".
        historyMaxRef.current = page.messages.reduce((max, m) => {
          const t = new Date(m.createdAt).getTime();
          return Number.isNaN(t) ? max : Math.max(max, t);
        }, 0);
        newestIdRef.current = null;
        setNewCount(0);
        setMessages(mergeById([], page.messages));
        setHasOlder(page.hasMore);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        setError(communicationErrorMessage(err));
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, authStatus]);

  /* ---------------- scroll helpers ---------------- */

  const scrollToBottom = useCallback((smooth: boolean) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
    setShowJumpToLatest(false);
    setNewCount(0);
  }, []);

  // Initial load: jump straight to the newest message, no animation.
  useEffect(() => {
    if (state === 'ready' && messages.length > 0) scrollToBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < 80;
    setShowJumpToLatest(!atBottomRef.current);
    // Reaching the bottom acknowledges whatever arrived while away.
    if (atBottomRef.current) setNewCount(0);
  }, []);

  /**
   * Count messages that arrive while the reader is NOT at the bottom, so the
   * jump pill can say how many there are. Runs on real state only: the first
   * page, older-history loads and messages read at the bottom add nothing.
   */
  useEffect(() => {
    if (state !== 'ready' || messages.length === 0) return;
    const newest = messages[messages.length - 1].id;
    const previous = newestIdRef.current;
    newestIdRef.current = newest;
    if (previous === null || previous === newest || atBottomRef.current) return;
    const previousIndex = messages.findIndex((m) => m.id === previous);
    const added = previousIndex === -1 ? 1 : messages.length - 1 - previousIndex;
    setNewCount((count) => count + Math.max(1, added));
  }, [messages, state]);

  // Composer grows with the draft (up to the CSS max-height), and collapses
  // back after a send clears it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft, state]);

  /* ---------------- read state ---------------- */

  const markRead = useCallback(async (conversationId: string) => {
    if (lastMarkedReadRef.current === conversationId) return;
    lastMarkedReadRef.current = conversationId;
    try {
      await markConversationRead(conversationId);
    } catch {
      // Read-state failures are non-fatal; the next open retries.
    }
  }, []);

  useEffect(() => {
    if (state !== 'ready' || !detail) return;
    void markRead(detail.conversation.id);
  }, [state, detail, markRead]);

  /* ---------------- realtime ---------------- */

  const handleRealtimeMessage = useCallback(
    (messageId: string, conversationId: string) => {
      // Fetch the authoritative message: the event carries ids only, so
      // content can never be spoofed by the transport.
      void (async () => {
        try {
          const page = await getConversationMessages(conversationId, { limit: 1 });
          const found = page.messages.find((m) => m.id === messageId);
          if (!found) return;
          setMessages((prev) => mergeById(prev, [found]));
          if (atBottomRef.current) scrollToBottom(true);
          void markRead(conversationId);
        } catch {
          // Realtime is best-effort; REST refetch can recover it.
        }
      })();
    },
    [markRead, scrollToBottom],
  );

  const handleReconnect = useCallback(async () => {
    if (!detail) return;
    try {
      const page = await getConversationMessages(detail.conversation.id, {
        limit: PAGE_SIZE,
      });
      setMessages((prev) => mergeById(prev, page.messages));
      setHasOlder(page.hasMore);
      // Only follow the scroll if the reader was already at the bottom;
      // someone reading history is never yanked down.
      if (atBottomRef.current) scrollToBottom(false);
    } catch {
      // REST stays authoritative; the next load or event recovers history.
    }
  }, [detail, scrollToBottom]);

  const { status: rtStatus } = useChatRealtime({
    conversationId: detail?.conversation.id ?? null,
    onMessage: handleRealtimeMessage,
    // Reconnect catch-up (Task 33.3): events are ids only, so anything sent
    // while the socket was down was never seen. Re-read the newest page over
    // REST and merge by stable id — no lost messages, no duplicates.
    onReconnect: handleReconnect,
    enabled: state === 'ready',
  });

  /* ---------------- send ---------------- */

  /**
   * Send one text as a new message.
   *
   * `replacesId` is only used by a retry: it swaps the failed row for a fresh
   * optimistic one so the same text is never shown twice. Nothing here
   * invents content — the text either reaches the server (which then returns
   * the authoritative row) or the row is marked `failed` and stays visible.
   */
  const sendText = useCallback(
    async (raw: string, replacesId?: string) => {
      if (!detail || sending) return;
      const text = raw.trim();
      if (!text || text.length > MAX_MESSAGE_LENGTH) return;

      const optimisticId = `pending-${generateUUID()}`;
      const optimistic: DisplayMessage = {
        id: optimisticId,
        senderId: 'me',
        message: text,
        createdAt: new Date().toISOString(),
        readAt: null,
        pending: 'sending',
      };
      setMessages((prev) =>
        replacesId
          ? [...prev.filter((m) => m.id !== replacesId), optimistic]
          : [...prev, optimistic],
      );
      setDraft('');
      setSending(true);
      setError(null);
      atBottomRef.current = true;
      scrollToBottom(true);

      try {
        const saved = await sendConversationMessage(detail.conversation.id, { message: text });
        // Replace the optimistic row with the authoritative server row.
        setMessages((prev) =>
          mergeById(
            prev.filter((m) => m.id !== optimisticId),
            [saved],
          ),
        );
      } catch (err) {
        // The failed message stays visible and is explicitly retryable — it is
        // never silently discarded and never shown as delivered.
        setMessages((prev) =>
          prev.map((m) => (m.id === optimisticId ? { ...m, pending: 'failed' } : m)),
        );
        setError(communicationErrorMessage(err));
      } finally {
        setSending(false);
      }
    },
    [detail, sending, scrollToBottom],
  );

  const handleSend = useCallback(async () => {
    await sendText(draft);
  }, [sendText, draft]);

  /** Re-send a row that previously failed, in place of the failed copy. */
  const retryMessage = useCallback(
    (m: DisplayMessage) => {
      if (m.pending !== 'failed' || sending) return;
      void sendText(m.message, m.id);
    },
    [sendText, sending],
  );

  /* ---------------- older messages ---------------- */

  const loadOlder = useCallback(async () => {
    if (!detail || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const previousHeight = el?.scrollHeight ?? 0;
    const previousTop = el?.scrollTop ?? 0;
    try {
      const page = await getConversationMessages(detail.conversation.id, {
        limit: PAGE_SIZE,
        before: messages[0]?.id,
      });
      setMessages((prev) => mergeById(page.messages, prev));
      setHasOlder(page.hasMore);
      // Preserve the reader's position instead of jumping.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - previousHeight + previousTop;
      });
    } catch (err) {
      setError(communicationErrorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [detail, hasOlder, loadingOlder, messages]);

  /* ---------------- derived ---------------- */

  const other = detail?.otherParticipant;
  const headerTitle = useMemo(() => other?.displayName ?? 'Conversation', [other]);

  return (
    <DashboardLayout active="Messages">
      <main className="chat-page">
        <div className="chat-shell">
          {/* ---------------- header ---------------- */}
          <header className="chat-header">
            <button
              type="button"
              className="chat-header-back"
              onClick={() => router.back()}
              aria-label="Go back"
            >
              <LuArrowLeft size={18} aria-hidden="true" />
            </button>
            <div className="chat-header-identity">
              <div className="chat-avatar" aria-hidden="true">
                {(other?.displayName ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div>
                <h1>{headerTitle}</h1>
                <p className="chat-header-meta">
                  {other?.isTechnician ? 'Technician' : 'Customer'}
                  {detail?.request?.category ? ` · ${detail.request.category}` : ''}
                  {detail?.request?.city ? ` · ${detail.request.city}` : ''}
                </p>
              </div>
            </div>
            <div className="chat-header-actions">
              {contact.state.status === 'working' ? (
                <span className="chat-calling" role="status">
                  Connecting…
                </span>
              ) : (
                <button
                  type="button"
                  className="chat-call"
                  onClick={() => void contact.call({ label: other?.displayName ?? null })}
                  aria-label="Call participant"
                >
                  <LuPhone size={16} aria-hidden="true" /> Call
                </button>
              )}
            </div>
          </header>

          <ContactCallPanel state={contact.state} onCopy={contact.copy} />

          {/* ---------------- connection state ---------------- */}
          {(rtStatus === 'reconnecting' || rtStatus === 'connecting') && (
            <p className="chat-connection" role="status" data-rt-status={rtStatus}>
              {rtStatus === 'connecting' ? 'Connecting to live updates…' : 'Reconnecting…'}
            </p>
          )}
          {rtStatus === 'offline' && (
            <p className="chat-connection notice-ish" role="status">
              Live updates are paused — messages still appear when you send or reopen this
              conversation.
            </p>
          )}

          {/* ---------------- messages ---------------- */}
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={handleScroll}
            role="log"
            aria-live="polite"
            aria-label="Conversation messages"
          >
            {hasOlder && (
              <div className="chat-older">
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? (
                    <>
                      <LuRefreshCw size={13} className="spin" aria-hidden="true" /> Loading…
                    </>
                  ) : (
                    'Load older messages'
                  )}
                </button>
              </div>
            )}

            {state === 'loading' && (
              <div className="chat-status" role="status" aria-busy="true">
                <div className="chat-skeleton-group" aria-hidden="true">
                  <span className="chat-skeleton chat-skeleton-in" />
                  <span className="chat-skeleton chat-skeleton-out" />
                  <span className="chat-skeleton chat-skeleton-in" />
                </div>
                <p>Loading conversation…</p>
              </div>
            )}

            {state === 'unavailable' && (
              <div className="chat-status" role="status">
                <LuMessageSquare size={22} aria-hidden="true" />
                <h2>Chat is not available yet</h2>
                <p>
                  Chat unlocks once a technician has accepted the offer on this service request.
                </p>
                <Link className="button button-teal" href="/matching">
                  Back to requests
                </Link>
              </div>
            )}

            {state === 'error' && (
              <div className="chat-status" role="alert">
                <h2>Could not load this conversation</h2>
                <p>{error}</p>
                <button
                  type="button"
                  className="button button-teal"
                  onClick={() => router.refresh()}
                >
                  Try again
                </button>
              </div>
            )}

            {state === 'ready' && messages.length === 0 && (
              <div className="chat-status" role="status">
                <LuMessageSquare size={22} aria-hidden="true" />
                <h2>No messages yet</h2>
                <p>Say hello to get the job moving.</p>
              </div>
            )}

            {state === 'ready' &&
              messages.map((m, index) => {
                // Ownership is derived from the session, never from the
                // message: an optimistic row carries the local 'me' id until
                // the server replaces it with the authenticated user id.
                const isOutgoing = m.id.startsWith('pending-')
                  ? m.senderId === 'me'
                  : m.senderId === authUserId;
                const previous = index > 0 ? messages[index - 1] : null;
                const sameDay =
                  previous !== null && dayKey(previous.createdAt) === dayKey(m.createdAt);
                const showDay = !sameDay;
                // Consecutive rows from the same sender on the same day group
                // together instead of reading as separate blocks.
                const grouped = previous !== null && sameDay && previous.senderId === m.senderId;
                // Fresh = arrived after the initial page loaded: animate once,
                // never replay the whole history after a refresh.
                const ts = new Date(m.createdAt).getTime();
                const fresh =
                  !Number.isNaN(ts) && historyMaxRef.current > 0 && ts > historyMaxRef.current;
                const timeLabel = formatTime(m.createdAt);
                const dayLabel = showDay ? formatDayLabel(m.createdAt) : '';
                return (
                  <Fragment key={m.id}>
                    {showDay && dayLabel && (
                      <div className="chat-day" role="separator" aria-label={dayLabel}>
                        <span>{dayLabel}</span>
                      </div>
                    )}
                    <article
                      className={`bubble ${isOutgoing ? 'bubble-out' : 'bubble-in'}${
                        grouped && !showDay ? ' bubble-cont' : ''
                      }`}
                      data-status={m.pending ?? (m.readAt ? 'read' : 'sent')}
                      data-fresh={fresh ? 'in' : undefined}
                    >
                      <p className="bubble-text">
                        {!isOutgoing && (
                          <span className="sr-only">{other?.displayName ?? 'Participant'}: </span>
                        )}
                        {m.message}
                      </p>
                      <span className="bubble-meta">
                        {timeLabel && <time dateTime={m.createdAt}>{timeLabel}</time>}
                        {isOutgoing &&
                          (m.pending === 'sending' ? (
                            <span className="bubble-indicator" aria-label="Sending">
                              <LuRefreshCw size={11} className="spin" aria-hidden="true" />
                            </span>
                          ) : m.pending === 'failed' ? (
                            <button
                              type="button"
                              className="bubble-indicator bubble-failed"
                              onClick={() => retryMessage(m)}
                              disabled={sending}
                              aria-label="Message not sent — retry"
                            >
                              Not sent · Retry
                            </button>
                          ) : m.readAt ? (
                            <span className="bubble-indicator" aria-label="Read">
                              <LuCheckCheck size={12} aria-hidden="true" />
                            </span>
                          ) : (
                            <span className="bubble-indicator" aria-label="Sent">
                              <LuCheck size={12} aria-hidden="true" />
                            </span>
                          ))}
                      </span>
                    </article>
                  </Fragment>
                );
              })}

            <div ref={bottomRef} />
          </div>

          {(showJumpToLatest || newCount > 0) && (
            <button
              type="button"
              className="chat-jump"
              onClick={() => scrollToBottom(true)}
              aria-label={
                newCount > 0
                  ? `Jump to ${newCount} new message${newCount === 1 ? '' : 's'}`
                  : 'Jump to the newest messages'
              }
            >
              {newCount > 0
                ? `${newCount} new message${newCount === 1 ? '' : 's'}`
                : 'Jump to latest'}{' '}
              <LuArrowLeft size={12} style={{ transform: 'rotate(90deg)' }} aria-hidden="true" />
            </button>
          )}

          {/* ---------------- composer ---------------- */}
          <form
            className="chat-composer"
            aria-busy={sending}
            onSubmit={(event) => {
              event.preventDefault();
              void handleSend();
            }}
          >
            <label className="sr-only" htmlFor="chat-input">
              Message
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              value={draft}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder={state === 'ready' ? 'Write a message…' : 'Chat is not available'}
              disabled={state !== 'ready'}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  // `sendText` guards against a send already in flight, so a
                  // draft typed mid-send is kept, never dropped or duplicated.
                  if (!sending && draft.trim().length > 0) void handleSend();
                }
              }}
            />
            <button
              type="submit"
              className="button button-teal chat-send"
              disabled={state !== 'ready' || sending || draft.trim().length === 0}
              aria-label={sending ? 'Sending message' : 'Send message'}
            >
              {sending ? (
                <LuRefreshCw size={16} className="spin" aria-hidden="true" />
              ) : (
                <LuSendHorizontal size={16} aria-hidden="true" />
              )}
            </button>
          </form>

          {error && state === 'ready' && (
            <p className="chat-error inline-error" role="alert">
              {error}
            </p>
          )}

          {draft.length > MAX_MESSAGE_LENGTH - 100 && (
            <p className="chat-counter" aria-live="polite">
              {draft.length}/{MAX_MESSAGE_LENGTH}
            </p>
          )}
        </div>
      </main>
    </DashboardLayout>
  );
}
