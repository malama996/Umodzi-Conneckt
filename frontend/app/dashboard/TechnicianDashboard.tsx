'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  LuArrowRight,
  LuBriefcaseBusiness,
  LuCircleCheck,
  LuClock,
  LuMapPin,
  LuMessageCircle,
  LuSend,
  LuUser,
} from 'react-icons/lu';
import { DashboardLayout, Badge } from '@/components/ui';
import PushSubscriptionControl from '@/components/PushSubscriptionControl';
import Reveal from '@/components/Reveal';
import { useAuth } from '@/lib/auth';
import { usePendingOffersCount } from '@/lib/offers/usePendingOffersCount';
import {
  listMyServiceRequests,
  requestErrorMessage,
  type MyServiceRequest,
} from '@/lib/api/serviceRequestsApi';
import { STATUS_LABEL, STATUS_TONE } from './ConsumerDashboard';
import type { ServiceRequestStatus } from '@/lib/types';

/**
 * Technician dashboard home (follow-up pass).
 *
 * Until now a signed-in technician was shown the CONSUMER dashboard —
 * "Need a technician?" CTAs, "Service requests you have raised" stats —
 * all of it written for the wrong role. The data underneath already
 * worked: GET /me/requests is role-aware and returns, for a technician,
 * the requests they hold or held an offer on (their job history), so
 * this component only changes the words and destinations, never the
 * contracts or the server.
 *
 * Every figure is real data from owner-scoped endpoints; every card and
 * quick action links somewhere that exists (no "#" targets, no static
 * cards). Statuses reuse the shared label/tone maps from
 * ConsumerDashboard so the 7-value vocabulary reads the same in both
 * dashboards.
 */

/** Statuses that are an active job from the technician's side. */
const ACTIVE_STATUSES: ReadonlySet<ServiceRequestStatus> = new Set([
  'matched',
  'in_progress',
]);

const RECENT_LIMIT = 5;

export default function TechnicianDashboard() {
  const { user } = useAuth();
  const pendingOffers = usePendingOffersCount();
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
  const active = requests?.filter((r) => ACTIVE_STATUSES.has(r.status)).length ?? 0;
  const completed = requests?.filter((r) => r.status === 'completed').length ?? 0;
  const recent = requests?.slice(0, RECENT_LIMIT) ?? [];

  return (
    <DashboardLayout active="Dashboard">
      <main className="dashboard-page">
        <Reveal>
          <div className="dashboard-heading">
            <div>
              <h1>
                {firstName ? `Welcome back, ${firstName}` : 'Your workbench'}{' '}
                <span>👋</span>
              </h1>
              <p>Here’s where your assignments and offers stand.</p>
            </div>
            <Badge tone="teal">
              <LuMapPin size={10} aria-hidden="true" /> Kitwe · Ndola
            </Badge>
          </div>
        </Reveal>

        <section className="stat-grid reveal-group" aria-label="Your work at a glance">
          <Reveal>
            <article className="card-clickable">
              <span className="stat-icon teal">
                <LuBriefcaseBusiness aria-hidden="true" />
              </span>
              <div>
                <b>{loading ? '…' : total}</b>
                <small>Assignments you have held</small>
              </div>
              <Link
                className="card-link-overlay"
                href="/dashboard/requests"
                aria-label="Open your assignments"
              />
            </article>
          </Reveal>
          <Reveal>
            <article className="card-clickable">
              <span className="stat-icon blue">
                <LuClock aria-hidden="true" />
              </span>
              <div>
                <b>{loading ? '…' : active}</b>
                <small>Active jobs right now</small>
              </div>
              <Link
                className="card-link-overlay"
                href="/dashboard/requests"
                aria-label="Open your assignments"
              />
            </article>
          </Reveal>
          <Reveal>
            <article className="card-clickable">
              <span className="stat-icon green">
                <LuCircleCheck aria-hidden="true" />
              </span>
              <div>
                <b>{loading ? '…' : completed}</b>
                <small>Completed jobs</small>
              </div>
              <Link
                className="card-link-overlay"
                href="/dashboard/requests"
                aria-label="Open your assignments"
              />
            </article>
          </Reveal>
          <Reveal>
            <article className="card-clickable">
              <span className="stat-icon coral">
                <LuSend aria-hidden="true" />
              </span>
              <div>
                <b>{pendingOffers}</b>
                <small>Offers waiting for your response</small>
              </div>
              <Link
                className="card-link-overlay"
                href="/technician/offers"
                aria-label="Open your offers"
              />
            </article>
          </Reveal>
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
            <Reveal>
              <article className="request-banner">
                <div>
                  <h2>Offer waiting on you?</h2>
                  <p>
                    Dispatched offers appear in your offers list. Accept to lock in
                    the job — or decline so it moves on.
                  </p>
                  <Link href="/technician/offers" className="button button-coral">
                    Review offers <LuArrowRight size={14} aria-hidden="true" />
                  </Link>
                </div>
                <div className="mini-city" />
              </article>
            </Reveal>

            <div className="panel">
              <Reveal>
                <div className="panel-head">
                  <div>
                    <h2>Recent assignments</h2>
                    <p className="panel-sub">
                      Your latest jobs and where each one stands.
                    </p>
                  </div>
                  {total > RECENT_LIMIT && (
                    <Link className="outline-button" href="/dashboard/requests">
                      View all {total}
                    </Link>
                  )}
                </div>
              </Reveal>

              {loading && (
                <p className="panel-sub" role="status">
                  Loading your assignments…
                </p>
              )}

              {!loading && requests && requests.length === 0 && (
                <div className="empty-state">
                  <LuBriefcaseBusiness size={22} aria-hidden="true" />
                  <h3>No assignments yet</h3>
                  <p>
                    When dispatch sends you an offer and you accept it, the job
                    appears here.
                  </p>
                  <Link className="button button-teal" href="/technician/offers">
                    Review offers
                  </Link>
                </div>
              )}

              {!loading && recent.length > 0 && (
                <ul className="inbox-list reveal-group">
                  {recent.map((request) => (
                    <Reveal as="li" key={request.id}>
                      <div className="inbox-item">
                        <Link
                          className="inbox-item-button"
                          href={`/dashboard/requests/${request.id}`}
                          aria-label={`Open ${request.category} assignment details`}
                        >
                          <span className="inbox-item-top">
                            <span className="inbox-item-type">{request.category}</span>
                            <time dateTime={request.createdAt}>
                              {new Date(request.createdAt).toLocaleDateString()}
                            </time>
                          </span>
                          <span className="inbox-item-message">{request.description}</span>
                          <span className="inbox-item-meta">
                            <span className="inbox-channel">
                              <LuMapPin size={11} className="ic" aria-hidden="true" />{' '}
                              {request.city}
                            </span>
                            <Badge tone={STATUS_TONE[request.status]}>
                              {STATUS_LABEL[request.status]}
                            </Badge>
                          </span>
                        </Link>
                      </div>
                    </Reveal>
                  ))}
                </ul>
              )}

              <p className="form-note">
                <Link href="/dashboard/requests">
                  View all your assignments <LuArrowRight size={11} aria-hidden="true" />
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
                  'My Assignments',
                  '/dashboard/requests',
                  <LuBriefcaseBusiness key="jobs" size={13} aria-hidden="true" />,
                ],
                [
                  'Offers',
                  '/technician/offers',
                  <LuSend key="send" size={13} aria-hidden="true" />,
                ],
                [
                  'Messages',
                  '/dashboard/messages',
                  <LuMessageCircle key="messages" size={13} aria-hidden="true" />,
                ],
                [
                  'My Profile',
                  '/technician/profile',
                  <LuUser key="user" size={13} aria-hidden="true" />,
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
