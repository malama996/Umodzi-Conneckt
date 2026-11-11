'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  LuArrowRight,
  LuCircleAlert,
  LuClipboardList,
  LuSend,
  LuShieldCheck,
  LuUser,
  LuUsers,
  LuWrench,
} from 'react-icons/lu';
import { Badge, DashboardLayout } from '@/components/ui';
import PushSubscriptionControl from '@/components/PushSubscriptionControl';
import Reveal from '@/components/Reveal';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import { OfferStatusBadge, RequestStatusBadge, RoleBadge } from '@/components/admin/StatusBadge';
import type { AdminOverview as Overview } from '@/lib/api/adminApi';
import {
  adminErrorMessage,
  fetchAdminOverview,
  formatTimestamp,
} from '@/lib/services/adminService';

/**
 * Administrator platform overview (Task 25 §2) — rendered as /dashboard
 * for administrators.
 *
 * Every figure comes from GET /api/v1/admin/overview, a server-side
 * aggregate over real rows; nothing on this screen is estimated, mocked,
 * or computed in the browser. The window has loading, error (+ retry),
 * and empty states, and the recent-activity feed merges real request,
 * account, and offer rows newest-first.
 *
 * No static cards: every stat card and activity row is a real link to
 * the list it belongs to (stretched-overlay pattern — the visible card
 * stays an <article>, the <Link> covers its full hit area).
 */
export default function AdminOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(await fetchAdminOverview());
    } catch (err) {
      setOverview(null);
      setError(adminErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DashboardLayout active="Overview">
      <main className="dashboard-page admin-page">
        <Reveal>
          <div className="dashboard-heading">
            <div>
              <h1>Platform overview</h1>
              <p>Real counts from users, technicians, and service requests.</p>
            </div>
            <Badge tone="teal">
              <LuShieldCheck size={10} aria-hidden="true" /> Administrator
            </Badge>
          </div>
        </Reveal>

        {error ? (
          <AdminError message={error} onRetry={() => void load()} />
        ) : overview === null ? (
          <AdminLoading label="Loading platform overview…" />
        ) : (
          <>
            <section
              className="stat-grid admin-stats reveal-group"
              aria-label="Platform statistics"
            >
              <Reveal>
                <article className="card-clickable">
                  <span className="stat-icon blue">
                    <LuUsers aria-hidden="true" />
                  </span>
                  <div>
                    <b>{overview.users.total}</b>
                    <small>
                      {overview.users.byRole.customer} customers ·{' '}
                      {overview.users.byRole.technician} technicians ·{' '}
                      {overview.users.byRole.administrator} administrators
                    </small>
                  </div>
                  <Link
                    className="card-link-overlay"
                    href="/admin/users"
                    aria-label="Open the user list"
                  />
                </article>
              </Reveal>
              <Reveal>
                <article className="card-clickable">
                  <span className="stat-icon teal">
                    <LuWrench aria-hidden="true" />
                  </span>
                  <div>
                    <b>{overview.technicians.total}</b>
                    <small>
                      {overview.technicians.active} active · {overview.technicians.available}{' '}
                      available
                    </small>
                  </div>
                  <Link
                    className="card-link-overlay"
                    href="/admin/technicians"
                    aria-label="Open the technician list"
                  />
                </article>
              </Reveal>
              <Reveal>
                <article className="card-clickable">
                  <span className="stat-icon green">
                    <LuClipboardList aria-hidden="true" />
                  </span>
                  <div>
                    <b>{overview.requests.total}</b>
                    <small>
                      {overview.requests.open} open · {overview.requests.completed} completed ·{' '}
                      {overview.requests.cancelled} cancelled
                    </small>
                  </div>
                  <Link
                    className="card-link-overlay"
                    href="/admin/requests"
                    aria-label="Open the request monitor"
                  />
                </article>
              </Reveal>
              <Reveal>
                <article className="card-clickable">
                  <span className="stat-icon coral">
                    <LuCircleAlert aria-hidden="true" />
                  </span>
                  <div>
                    <b>{overview.requests.noMatch}</b>
                    <small>No-match · unresolved</small>
                  </div>
                  <Link
                    className="card-link-overlay"
                    href="/admin/requests"
                    aria-label="Open the request monitor filtered to problem requests"
                  />
                </article>
              </Reveal>
              <Reveal>
                <article className="card-clickable">
                  <span className="stat-icon green">
                    <LuShieldCheck aria-hidden="true" />
                  </span>
                  <div>
                    <b>{overview.technicians.verified}</b>
                    <small>verified · {overview.technicians.unverified} unverified</small>
                  </div>
                  <Link
                    className="card-link-overlay"
                    href="/admin/technicians"
                    aria-label="Open technician verification"
                  />
                </article>
              </Reveal>
              <Reveal>
                <article className="card-clickable">
                  <span className="stat-icon teal">
                    <LuSend aria-hidden="true" />
                  </span>
                  <div>
                    <b>{overview.offers.total}</b>
                    <small>
                      {overview.offers.accepted} accepted · {overview.offers.pending} pending ·{' '}
                      {overview.offers.rejected} rejected
                    </small>
                  </div>
                  <Link
                    className="card-link-overlay"
                    href="/admin/requests"
                    aria-label="Open the request monitor to see dispatch offers"
                  />
                </article>
              </Reveal>
            </section>

            <section className="admin-activity">
              <Reveal>
                <div className="dashboard-section-head">
                  <h2>Recent platform activity</h2>
                  <Link href="/admin/requests">
                    Monitor requests <LuArrowRight size={11} className="ic" aria-hidden="true" />
                  </Link>
                </div>
              </Reveal>
              {overview.recent.length === 0 ? (
                <AdminEmpty title="No platform activity yet." />
              ) : (
                <div className="recent-list reveal-group">
                  {overview.recent.map((event) => {
                    if (event.kind === 'request') {
                      return (
                        <Reveal key={`request-${event.id}`}>
                          <article className="card-clickable">
                            <span className="recent-avatar">
                              <LuClipboardList aria-hidden="true" />
                            </span>
                            <div>
                              <b>New request · {event.category}</b>
                              <small>
                                {event.city} · created {formatTimestamp(event.at)}
                              </small>
                            </div>
                            <RequestStatusBadge status={event.status} />
                            <Link
                              className="card-link-overlay"
                              href="/admin/requests"
                              aria-label={`Open the request monitor at ${event.category}`}
                            />
                          </article>
                        </Reveal>
                      );
                    }
                    if (event.kind === 'user') {
                      return (
                        <Reveal key={`user-${event.id}`}>
                          <article className="card-clickable">
                            <span className="recent-avatar">
                              <LuUser aria-hidden="true" />
                            </span>
                            <div>
                              <b>
                                New {event.role} account · {event.email}
                              </b>
                              <small>Joined {formatTimestamp(event.at)}</small>
                            </div>
                            <RoleBadge role={event.role} />
                            <Link
                              className="card-link-overlay"
                              href="/admin/users"
                              aria-label={`Open the user list at ${event.email}`}
                            />
                          </article>
                        </Reveal>
                      );
                    }
                    return (
                      <Reveal key={`offer-${event.id}`}>
                        <article className="card-clickable">
                          <span className="recent-avatar">
                            <LuSend aria-hidden="true" />
                          </span>
                          <div>
                            <b>Offer to {event.technicianName}</b>
                            <small>
                              {event.category} request · {formatTimestamp(event.at)}
                            </small>
                          </div>
                          <OfferStatusBadge status={event.status} />
                          <Link
                            className="card-link-overlay"
                            href="/admin/requests"
                            aria-label={`Open the request monitor at the offer to ${event.technicianName}`}
                          />
                        </article>
                      </Reveal>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
        {/* Task 28.2C: browser push subscription control (additive). */}
        <PushSubscriptionControl />
      </main>
    </DashboardLayout>
  );
}
