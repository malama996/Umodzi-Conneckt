'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LuBell, LuCheck, LuInbox, LuMessageSquare } from 'react-icons/lu';

import {
  getMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  privacyErrorMessage,
  type NotificationItem,
  type NotificationPage,
} from '@/lib/api/privacyApi';

/**
 * Notification inbox (Task 28.3C — closes gap G-02).
 *
 * Before 28.3C the application persisted notifications and could push them to
 * a device, but exposed NO route for a person to read their own history. That
 * is now a real inbox on top of the existing notifications table and the D1
 * NotificationService read methods — this component introduces no second
 * notification store and changes no delivery behaviour.
 *
 * Design rules (matching the rest of Theme B):
 *   - honest empty state: an account with no notifications is told so plainly,
 *     and no placeholder rows are invented to fill the list;
 *   - low-data: one small page of 25 at a time, with "load more";
 *   - the recipient is decided server-side from the session — this component
 *     never sends, stores or filters by a user id;
 *   - reads are marked read on demand, never automatically in bulk.
 */

const PAGE_SIZE = 25;

/** Human label for a notification type, falling back to the raw type. */
function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    service_request_created: 'Request received',
    service_request_status_changed: 'Request updated',
    dispatch_offer_received: 'New offer',
    dispatch_offer_accepted: 'Offer accepted',
    dispatch_offer_rejected: 'Offer declined',
    dispatch_offer_timeout: 'Offer expired',
    technician_verification_approved: 'Verification approved',
    technician_verification_rejected: 'Verification rejected',
    technician_verification_submitted: 'Verification submitted',
    chat_message: 'New message',
  };
  return labels[type] ?? type.replace(/_/g, ' ');
}

/** Short, honest timestamp — no heavy date library for a low-data list. */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export default function NotificationInbox() {
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = await getMyNotifications(PAGE_SIZE, offset);
      setPage((prev) =>
        append && prev
          ? {
              ...result,
              notifications: [...prev.notifications, ...result.notifications],
            }
          : result,
      );
      setError(null);
    } catch (err) {
      setError(privacyErrorMessage(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(0, false);
  }, [load]);

  const openNotification = async (item: NotificationItem) => {
    if (item.read) return;
    setBusyId(item.id);
    // Optimistic, then reconciled — a read receipt is not worth a full reload.
    setPage((prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.map((n) =>
              n.id === item.id ? { ...n, read: true, readAt: new Date().toISOString() } : n,
            ),
            unreadCount: Math.max(0, prev.unreadCount - 1),
          }
        : prev,
    );
    try {
      await markNotificationRead(item.id);
    } catch {
      // Roll the optimistic update back so the UI never claims a read that
      // the server did not accept.
      try {
        const fresh = await getMyNotifications(PAGE_SIZE, 0);
        setPage(fresh);
      } catch {
        /* leave the optimistic state; the next reload reconciles */
      }
      setError('Could not mark that notification as read.');
    } finally {
      setBusyId(null);
    }
  };

  const markAll = async () => {
    try {
      const updated = await markAllNotificationsRead();
      setPage((prev) =>
        prev
          ? {
              ...prev,
              unreadCount: 0,
              notifications: prev.notifications.map((n) => ({
                ...n,
                read: true,
                readAt: n.readAt ?? new Date().toISOString(),
              })),
            }
          : prev,
      );
      // "0 updated" is shown honestly when there was nothing unread.
      if (updated === 0) setError(null);
    } catch (err) {
      setError(privacyErrorMessage(err));
    }
  };

  const items = page?.notifications ?? [];

  return (
    <section className="panel" aria-labelledby="inbox-heading">
      <div className="panel-head">
        <div>
          <div className="eyebrow eyebrow-dark">YOUR ACTIVITY</div>
          <h2 id="inbox-heading">
            <LuBell size={16} className="ic" aria-hidden="true" /> Notifications
          </h2>
          <p className="panel-sub">
            {loading
              ? 'Loading your notifications…'
              : page
                ? `${page.totalCount} total · ${page.unreadCount} unread`
                : ''}
          </p>
        </div>
        <button
          type="button"
          className="outline-button"
          onClick={() => void markAll()}
          disabled={!page || page.unreadCount === 0}
        >
          <LuCheck size={12} className="ic" aria-hidden="true" /> Mark all read
        </button>
      </div>

      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="empty-state">
          <LuInbox size={22} aria-hidden="true" />
          <h3>No notifications yet</h3>
          <p>
            When something happens with your requests, offers or verification, it will appear here.
          </p>
        </div>
      )}

      <ul className="inbox-list">
        {items.map((item) => (
          <li key={item.id} className={`inbox-item ${item.read ? 'inbox-read' : 'inbox-unread'}`}>
            <button
              type="button"
              className="inbox-item-button"
              onClick={() => void openNotification(item)}
              disabled={busyId === item.id}
              aria-label={`${item.read ? 'Read' : 'Unread'}: ${item.title}`}
            >
              <span className="inbox-item-top">
                <span className="inbox-item-type">{typeLabel(item.type)}</span>
                <time dateTime={item.createdAt}>{formatWhen(item.createdAt)}</time>
              </span>
              <span className="inbox-item-title">{item.title}</span>
              <span className="inbox-item-message">{item.message}</span>
              <span className="inbox-item-meta">
                <span className={`inbox-channel inbox-channel-${item.channel}`}>
                  {item.channel === 'in_app' ? 'In app' : item.channel.toUpperCase()}
                </span>
                {item.status === 'failed' && (
                  <span className="inbox-channel inbox-channel-failed">Delivery failed</span>
                )}
                {!item.read && (
                  <span className="inbox-dot" aria-label="Unread">
                    ●
                  </span>
                )}
              </span>
            </button>
            {/* Real deep link: only rendered when the persisted row actually
                carries a conversation reference (Task 28.4B). No reference,
                no link — nothing is invented for rows without one. */}
            {item.referenceType === 'conversation' && item.referenceId && (
              <Link
                className="outline-button inbox-open"
                href={`/dashboard/messages/${item.referenceId}`}
                onClick={() => void openNotification(item)}
                aria-label={`Open the chat for ${item.title}`}
              >
                <LuMessageSquare size={12} className="ic" aria-hidden="true" /> Open chat
              </Link>
            )}
          </li>
        ))}
      </ul>

      {page?.hasMore && (
        <button
          type="button"
          className="outline-button inbox-more"
          onClick={() => void load(items.length, true)}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
