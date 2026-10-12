'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { LuShieldCheck } from 'react-icons/lu';

import RequireAuth from '@/components/RequireAuth';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import { Badge, DashboardLayout, type BadgeTone } from '@/components/ui';
import { AUDIT_EVENT_TYPES, type AuditEvent, type AuditEventQuery } from '@/lib/api/adminApi';
import {
  adminErrorMessage,
  fetchAuditEvents,
  formatAuditMetadata,
  formatTimestamp,
} from '@/lib/services/adminService';

/**
 * /admin/audit — the administrator audit log (Phase 6).
 *
 * The backend has written an audit row for every privileged action since
 * Task 28.3F (account status changes, verification decisions, verification
 * document access, data exports, account deletions, failed logins) and
 * exposes them at GET /admin/audit-events — but nothing in the UI ever read
 * them. §7 asks for "audit views where required by sensitive operations", and
 * §9 for existing backend capability to be surfaced; both apply here.
 *
 * Authorization: RequireAuth blocks the route for UX, and the endpoint itself
 * is `requireRole('administrator')`, so a non-administrator gets 403 from the
 * server regardless of what the client renders. The filter values are
 * forwarded to the server, which validates them (400 outside the vocabulary)
 * — this page never filters results on its own.
 *
 * No row is invented: an account with no recorded events gets an honest
 * empty state, and a failure is shown rather than rendered as "no events".
 */

const PAGE_SIZE = 50;

type OutcomeFilter = '' | 'success' | 'failure' | 'denied';

const OUTCOME_TONE: Record<string, BadgeTone> = {
  success: 'success',
  failure: 'coral',
  denied: 'warning',
};

const OUTCOME_LABEL: Record<string, string> = {
  success: 'Success',
  failure: 'Failure',
  denied: 'Denied',
};

export default function AdminAuditPage() {
  return (
    <RequireAuth role="administrator">
      <DashboardLayout active="Audit log">
        <AdminAuditView />
      </DashboardLayout>
    </RequireAuth>
  );
}

function AdminAuditView() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventType, setEventType] = useState<string>('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('');

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const query: AuditEventQuery = { limit: PAGE_SIZE, offset };
        if (eventType) query.eventType = eventType;
        if (outcome) query.outcome = outcome;
        const result = await fetchAuditEvents(query);
        setTotal(result.total);
        setHasMore(result.hasMore);
        setEvents((prev) => (offset === 0 ? result.events : [...(prev ?? []), ...result.events]));
      } catch (err) {
        setEvents(null);
        setError(adminErrorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    // Changing either filter reloads from the first page.
    [eventType, outcome],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <main className="dashboard-page admin-page">
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow eyebrow-dark">ADMINISTRATOR</div>
          <h1>Audit log</h1>
          <p>
            Privileged and security-sensitive activity recorded by the server: account changes,
            verification decisions, document access, exports, and sign-in outcomes.
          </p>
        </div>
        <Badge tone="teal">
          <LuShieldCheck size={10} aria-hidden="true" /> {events ? `${total} events` : 'Loading…'}
        </Badge>
      </div>

      <div className="admin-toolbar">
        <label className="admin-field">
          <span>Event type</span>
          <select value={eventType} onChange={(event) => setEventType(event.target.value)}>
            <option value="">All event types</option>
            {AUDIT_EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>Outcome</span>
          <select
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as OutcomeFilter)}
          >
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="denied">Denied</option>
          </select>
        </label>
        {(eventType !== '' || outcome !== '') && (
          <button
            type="button"
            className="admin-action"
            onClick={() => {
              setEventType('');
              setOutcome('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className="admin-count" role="status">
        {loading && events === null
          ? 'Loading audit events…'
          : events
            ? `Showing ${events.length} of ${total} ${total === 1 ? 'event' : 'events'}`
            : ''}
      </p>

      {error ? (
        <AdminError message={error} onRetry={() => void load(events?.length ?? 0)} />
      ) : events === null ? (
        <AdminLoading label="Loading audit events…" />
      ) : events.length === 0 ? (
        <AdminEmpty
          title="No audit events recorded yet."
          hint="Privileged actions will appear here as soon as the server records one. If you have just signed in or changed an account, try again in a moment."
        />
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="admin-table-caption">
              Server-recorded audit events, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Actor</th>
                <th scope="col">Outcome</th>
                <th scope="col">Target</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const metadata = formatAuditMetadata(event.metadata);
                return (
                  <Fragment key={event.id}>
                    <tr>
                      <td data-label="When">{formatTimestamp(event.created_at)}</td>
                      <td data-label="Event">
                        <span className="admin-cell-strong">{event.event_type}</span>
                      </td>
                      <td data-label="Actor">
                        <span className="admin-cell-strong">
                          {event.actor_role ?? 'unauthenticated'}
                        </span>
                        {event.actor_user_id && (
                          <span className="admin-cell-sub">{event.actor_user_id}</span>
                        )}
                      </td>
                      <td data-label="Outcome">
                        <Badge tone={OUTCOME_TONE[event.outcome] ?? 'neutral'}>
                          {OUTCOME_LABEL[event.outcome] ?? event.outcome}
                        </Badge>
                      </td>
                      <td data-label="Target">
                        <span className="admin-cell-strong">{event.target_entity_type ?? '—'}</span>
                        {event.target_entity_id && (
                          <span className="admin-cell-sub">{event.target_entity_id}</span>
                        )}
                      </td>
                      <td data-label="Detail">
                        {metadata ? (
                          <span className="admin-cell-sub">{metadata}</span>
                        ) : (
                          <span className="admin-note">—</span>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && !error && (
        <div className="admin-actions">
          <button
            type="button"
            className="admin-action"
            disabled={loading}
            onClick={() => void load(events?.length ?? 0)}
          >
            {loading
              ? 'Loading…'
              : `Load ${Math.min(PAGE_SIZE, total - (events?.length ?? 0))} more`}
          </button>
        </div>
      )}

      <p className="admin-footnote">
        Rows are minimised on the server: identifiers are opaque and no personal data is stored
        here. This view is read-only — it can never change an account, a request, or a verification
        decision.
      </p>
    </main>
  );
}
