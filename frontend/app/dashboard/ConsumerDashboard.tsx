'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  LuArrowRight,
  LuCircleAlert,
  LuCircleCheck,
  LuClipboardList,
  LuClock,
  LuMapPin,
  LuMessageCircle,
  LuPlus,
  LuSearch,
} from 'react-icons/lu';
import { DashboardLayout, Badge, type BadgeTone } from '@/components/ui';
import PushSubscriptionControl from '@/components/PushSubscriptionControl';
import { useAuth } from '@/lib/auth';
import {
  listMyServiceRequests,
  requestErrorMessage,
  type MyServiceRequest,
} from '@/lib/api/serviceRequestsApi';
import type { ServiceRequestStatus } from '@/lib/types';

/**
 * Customer dashboard (Phase 4).
 *
 * It previously rendered four statistic cards whose values were all "—",
 * a "recent" list containing only a note, and a Quick Action labelled
 * "Help & Support" that pointed at "#". None of it was wrong exactly — but
 * none of it was information either.
 *
 * §5 asks for a personalised welcome, current and recent service requests,
 * status and next steps, and clear empty/loading/failure states. All of that
 * now comes from GET /me/requests (the endpoint added in Phase 4). If the
 * request fails, the failure is shown — no placeholder numbers are invented.
 */

const OPEN_STATUSES: ReadonlySet<ServiceRequestStatus> = new Set([
  'pending',
  'matching',
  'matched',
  'in_progress',
]);

const STATUS_LABEL: Record<ServiceRequestStatus, string> = {
  pending: 'Pending',
  matching: 'Finding a technician',
  matched: 'Matched',
  no_match: 'No technician found',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<ServiceRequestStatus, BadgeTone> = {
  pending: 'neutral',
  matching: 'teal',
  matched: 'success',
  no_match: 'coral',
  in_progress: 'teal',
  completed: 'success',
  cancelled: 'neutral',
};

const RECENT_LIMIT = 5;

export default function ConsumerDashboard() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<MyServiceRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRequests(await listMyServiceRequests());
      setError(null);
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const firstName = user?.firstName?.trim() || '';
  const total = requests?.length ?? 0;
  const open = requests?.filter((r) => OPEN_STATUSES.has(r.status)).length ?? 0;
  const completed = requests?.filter((r) => r.status === 'completed').length ?? 0;
  const recent = requests?.slice(0, RECENT_LIMIT) ?? [];

  return (
    <DashboardLayout active="Dashboard">
      <main className="dashboard-page">
        <div className="dashboard-heading">
          <div>
            <div className="eyebrow eyebrow-dark">CONSUMER DASHBOARD</div>
            <h1>
              {firstName ? `Welcome back, ${firstName}` : 'Your service workspace'} <span>👋</span>
            </h1>
            <p>Here’s what’s happening with your services.</p>
          </div>
          <Badge tone="teal">
            <LuMapPin size={10} aria-hidden="true" /> Kitwe · Ndola
          </Badge>
        </div>

        <section className="stat-grid" aria-label="Your activity at a glance">
          <article>
            <span className="stat-icon teal">
              <LuClipboardList aria-hidden="true" />
            </span>
            <div>
              <b>{loading ? '…' : total}</b>
              <small>Service requests you have raised</small>
            </div>
          </article>
          <article>
            <span className="stat-icon blue">
              <LuClock aria-hidden="true" />
            </span>
            <div>
              <b>{loading ? '…' : open}</b>
              <small>Still open or in progress</small>
            </div>
          </article>
          <article>
            <span className="stat-icon green">
              <LuCircleCheck aria-hidden="true" />
            </span>
            <div>
              <b>{loading ? '…' : completed}</b>
              <small>Completed services</small>
            </div>
          </article>
          <article>
            <span className="stat-icon coral">
              <LuCircleAlert aria-hidden="true" />
            </span>
            <div>
              <b>{loading ? '…' : total - open - completed}</b>
              <small>Cancelled or without a match</small>
            </div>
          </article>
        </section>

        {error && (
          <p className="inline-error" role="alert">
            {error}{' '}
            <button type="button" className="link-button" onClick={() => void load()}>
              Try again
            </button>
          </p>
        )}

        <section className="dashboard-grid">
          <div className="dashboard-left">
            <article className="request-banner">
              <div>
                <div className="eyebrow">NEW SERVICE REQUEST</div>
                <h2>Need a technician?</h2>
                <p>Describe your issue and we’ll help you find a relevant local skill.</p>
                <Link href="/matching" className="button button-coral">
                  Create Service Request <LuArrowRight size={14} aria-hidden="true" />
                </Link>
              </div>
              <div className="mini-city" />
            </article>

            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Recent requests</h2>
                  <p className="panel-sub">Your latest service requests and where they stand.</p>
                </div>
                {total > RECENT_LIMIT && (
                  <Link className="outline-button" href="/dashboard/requests">
                    View all {total}
                  </Link>
                )}
              </div>

              {loading && (
                <p className="panel-sub" role="status">
                  Loading your requests…
                </p>
              )}

              {!loading && requests && requests.length === 0 && (
                <div className="empty-state">
                  <LuClipboardList size={22} aria-hidden="true" />
                  <h3>No requests yet</h3>
                  <p>When something needs fixing, describe it and we’ll find someone local.</p>
                  <Link className="button button-teal" href="/matching">
                    Create Service Request
                  </Link>
                </div>
              )}

              {!loading && recent.length > 0 && (
                <ul className="inbox-list">
                  {recent.map((request) => (
                    <li key={request.id} className="inbox-item">
                      <div className="inbox-item-button">
                        <span className="inbox-item-top">
                          <span className="inbox-item-type">{request.category}</span>
                          <time dateTime={request.createdAt}>
                            {new Date(request.createdAt).toLocaleDateString()}
                          </time>
                        </span>
                        <span className="inbox-item-message">{request.description}</span>
                        <span className="inbox-item-meta">
                          <span className="inbox-channel">
                            <LuMapPin size={11} className="ic" aria-hidden="true" /> {request.city}
                          </span>
                          <Badge tone={STATUS_TONE[request.status]}>
                            {STATUS_LABEL[request.status]}
                          </Badge>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <p className="form-note">
                <Link href="/dashboard/requests">
                  View all your requests <LuArrowRight size={11} aria-hidden="true" />
                </Link>
              </p>
            </div>
          </div>

          <aside className="quick-actions">
            <div className="dashboard-section-head">
              <h2>Quick Actions</h2>
            </div>
            {(
              [
                [
                  'Create Service Request',
                  '/matching',
                  <LuPlus key="plus" size={13} aria-hidden="true" />,
                ],
                [
                  'Browse Technicians',
                  '/matching',
                  <LuSearch key="search" size={13} aria-hidden="true" />,
                ],
                [
                  'My Requests',
                  '/dashboard/requests',
                  <LuClipboardList key="list" size={13} aria-hidden="true" />,
                ],
                [
                  'Messages',
                  '/dashboard/messages',
                  <LuMessageCircle key="messages" size={13} aria-hidden="true" />,
                ],
              ] as [string, string, ReactNode][]
            ).map(([label, href, icon]) => (
              <Link href={href} key={label}>
                <span>{icon}</span>
                {label}
                <b>
                  <LuArrowRight size={11} aria-hidden="true" />
                </b>
              </Link>
            ))}
          </aside>
        </section>

        {/* Browser push subscription control. */}
        <PushSubscriptionControl />
      </main>
    </DashboardLayout>
  );
}
