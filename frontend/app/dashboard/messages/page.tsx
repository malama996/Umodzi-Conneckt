'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { LuMessageSquare, LuPhone } from 'react-icons/lu';

import { listMyConversations, communicationErrorMessage } from '@/lib/api/communicationApi';
import { useContactCall } from '@/lib/chat/useContactCall';
import ContactCallPanel from '@/components/ContactCallPanel';
import RequireAuth from '@/components/RequireAuth';
import { DashboardLayout, Button } from '@/components/ui';
import type { ConversationSummary } from '@/lib/types/communication';

/**
 * /dashboard/messages — the authenticated user's conversations.
 *
 * Every row is real: the participant, latest message, timestamp and unread
 * count all come from the backend's owner-scoped query. An account with no
 * conversations gets an honest empty state rather than placeholder rows.
 *
 * Phase 2: wrapped in RequireAuth like every other dashboard route, so an
 * anonymous visitor is redirected to /login?next=… instead of receiving a
 * raw 401 from the conversation list.
 */
export default function MessagesIndexPage() {
  return (
    <RequireAuth>
      <ConversationsList />
    </RequireAuth>
  );
}

/** Sortable, honest timestamp: invalid input renders nothing, never "Invalid Date". */
function formatListTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const clock = { hour: '2-digit', minute: '2-digit' } as const;
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, clock);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString(undefined, clock)}`;
  }
  return date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function ConversationsList() {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listMyConversations();
      setConversations(list);
      setError(null);
    } catch (err) {
      setError(communicationErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Contact/call (Task 33.4): shared state machine — the number comes
  // from the backend and is shown with a tel: link + copy action, so the
  // desktop fallback is never a silent no-op.
  const contact = useContactCall();

  return (
    <DashboardLayout active="Messages">
      <main className="dashboard-content">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow eyebrow-dark">COMMUNICATION</div>
              <h2>
                <LuMessageSquare size={16} className="ic" aria-hidden="true" /> Messages
              </h2>
              <p className="panel-sub">
                Conversations open once a technician accepts an offer on your service request.
              </p>
            </div>
            <Button type="button" className="button button-teal" onClick={() => void load()}>
              Refresh
            </Button>
          </div>

          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}

          <ContactCallPanel state={contact.state} onCopy={contact.copy} showWorking />

          {loading && !conversations && (
            <>
              <p className="panel-sub" role="status">
                Loading conversations…
              </p>
              <ul className="inbox-list messages-list" aria-hidden="true">
                {[0, 1, 2].map((row) => (
                  <li key={row} className="inbox-item inbox-skeleton">
                    <span className="skeleton-line w-40" />
                    <span className="skeleton-line w-75" />
                    <span className="skeleton-line w-60" />
                    <span className="skeleton-line w-30" />
                  </li>
                ))}
              </ul>
            </>
          )}

          {!loading && conversations && conversations.length === 0 && (
            <div className="empty-state">
              <LuMessageSquare size={22} aria-hidden="true" />
              <h3>No conversations yet</h3>
              <p>
                When a technician accepts an offer on one of your requests, the conversation will
                appear here.
              </p>
              <Link className="button button-teal" href="/matching">
                Find a technician
              </Link>
            </div>
          )}

          {conversations && conversations.length > 0 && (
            <ul className="inbox-list messages-list">
              {conversations.map((conversation) => {
                const unread = conversation.unreadCount > 0;
                const timeSource = conversation.lastMessage?.createdAt ?? conversation.updatedAt;
                return (
                  <li
                    key={conversation.id}
                    className={`inbox-item ${unread ? 'inbox-unread' : 'inbox-read'}`}
                  >
                    <Link
                      className="inbox-item-button"
                      href={`/dashboard/messages/${conversation.serviceRequestId}`}
                    >
                      <span className="inbox-item-top">
                        <span className="inbox-item-type">
                          {conversation.otherParticipant.displayName}
                        </span>
                        <time dateTime={timeSource}>{formatListTime(timeSource)}</time>
                      </span>
                      <span className="inbox-item-title">
                        {conversation.request?.category ?? 'Service request'}
                      </span>
                      <span className="inbox-item-message">
                        {conversation.lastMessage?.message ?? 'No messages yet — say hello.'}
                      </span>
                      <span className="inbox-item-meta">
                        <span className="inbox-channel">
                          {conversation.otherParticipant.isTechnician ? 'Technician' : 'Customer'}
                        </span>
                        {unread && <span className="inbox-dot">{conversation.unreadCount}</span>}
                        <span className="sr-only">
                          {unread
                            ? `${conversation.unreadCount} unread messages`
                            : 'No unread messages'}
                        </span>
                      </span>
                    </Link>
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() =>
                        void contact.call({
                          requestId: conversation.serviceRequestId,
                          label: conversation.otherParticipant.displayName,
                        })
                      }
                      aria-label={`Call ${conversation.otherParticipant.displayName}`}
                    >
                      <LuPhone size={13} className="ic" aria-hidden="true" /> Call
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </DashboardLayout>
  );
}
