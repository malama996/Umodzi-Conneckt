'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { LuClipboardList, LuSearch } from 'react-icons/lu';
import RequireAuth from '@/components/RequireAuth';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import { OfferStatusBadge, RequestStatusBadge } from '@/components/admin/StatusBadge';
import { Badge, DashboardLayout } from '@/components/ui';
import type { AdminRequest } from '@/lib/api/adminApi';
import {
  adminErrorMessage,
  fetchAdminRequests,
  filterAdminRequests,
  formatTimestamp,
  requestStatusCounts,
  type AdminRequestStatusFilter,
} from '@/lib/services/adminService';

/**
 * Status filter chips — every request status gets its own chip with its
 * live count, so "No match" monitoring is a first-class view (Task 25 §6)
 * rather than a separate system: no-match IS a request status, and the
 * backend has no separate event log to redesign.
 */
const CHIPS: { key: AdminRequestStatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'matching', label: 'Matching' },
  { key: 'matched', label: 'Matched' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'no_match', label: 'No match' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

/**
 * Administrator request/platform monitoring (Task 25 §5 + §6) —
 * /admin/requests.
 *
 * Read-only: status, category/classification, city, customer identity,
 * dispatch-offer state (technician + status + timestamp), and timestamps
 * for every service request, newest first. Smart Dispatch itself
 * (ranking, candidate selection, offer cascades, realtime) is untouched;
 * no-match requests are exposed here through their existing status.
 */
export default function AdminRequestsPage() {
  return (
    <RequireAuth role="administrator">
      <DashboardLayout active="Requests">
        <AdminRequestsView />
      </DashboardLayout>
    </RequireAuth>
  );
}

function AdminRequestsView() {
  const [requests, setRequests] = useState<AdminRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<AdminRequestStatusFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await fetchAdminRequests());
    } catch (err) {
      setRequests(null);
      setError(adminErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = requestStatusCounts(requests ?? []);
  const filtered = filterAdminRequests(requests ?? [], { search, status: statusFilter });

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('all');
  };

  return (
    <main className="dashboard-page admin-page">
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow eyebrow-dark">ADMINISTRATOR</div>
          <h1>Request monitoring</h1>
          <p>Every service request with its matching, offering, and no-match state.</p>
        </div>
        <Badge tone="teal">
          <LuClipboardList size={10} aria-hidden="true" />{' '}
          {requests ? `${requests.length} requests` : 'Loading…'}
        </Badge>
      </div>

      {error ? (
        <AdminError message={error} onRetry={() => void load()} />
      ) : requests === null ? (
        <AdminLoading label="Loading service requests…" />
      ) : (
        <>
          <div className="admin-toolbar">
            <label className="admin-search">
              <LuSearch aria-hidden="true" />
              <input
                type="search"
                placeholder="Search category, city, description, or id…"
                aria-label="Search requests by category, city, description, or id"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          <div className="admin-chips" role="group" aria-label="Filter requests by status">
            {CHIPS.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className={`admin-chip ${statusFilter === chip.key ? 'admin-chip-active' : ''}`}
                aria-pressed={statusFilter === chip.key}
                onClick={() => setStatusFilter(chip.key)}
              >
                {chip.label} <b>{counts[chip.key]}</b>
              </button>
            ))}
          </div>

          <p className="admin-count" role="status">
            Showing {filtered.length} of {requests.length}{' '}
            {requests.length === 1 ? 'request' : 'requests'}
          </p>

          {filtered.length === 0 ? (
            <div className="admin-empty-block">
              {requests.length === 0 ? (
                <AdminEmpty
                  title="No service requests yet."
                  hint="Requests appear here the moment a customer creates one."
                />
              ) : (
                <AdminEmpty
                  title="No requests match this view."
                  hint="Pick another status chip or clear the search."
                />
              )}
              <button type="button" className="admin-action" onClick={resetFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <caption className="admin-table-caption">Service requests, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Request</th>
                    <th scope="col">City</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Offers</th>
                    <th scope="col">Created</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((request) => {
                    const expanded = expandedId === request.id;
                    const detailId = `request-detail-${request.id}`;
                    const shortDescription =
                      request.description.length > 90
                        ? `${request.description.slice(0, 90)}…`
                        : request.description;
                    return (
                      <Fragment key={request.id}>
                        <tr>
                          <td data-label="Status">
                            <span className="admin-cell-body">
                              <RequestStatusBadge status={request.status} />
                            </span>
                          </td>
                          <td data-label="Request">
                            <span className="admin-cell-body">
                              <span className="admin-cell-strong">{request.category}</span>
                              <span className="admin-cell-sub">{shortDescription}</span>
                            </span>
                          </td>
                          <td data-label="City">
                            <span className="admin-cell-body">{request.city}</span>
                          </td>
                          <td data-label="Customer">
                            <span className="admin-cell-body">
                              {request.customerEmail ? (
                                <>
                                  <span className="admin-cell-strong">
                                    {request.customerName ?? '—'}
                                  </span>
                                  <span className="admin-cell-sub">{request.customerEmail}</span>
                                </>
                              ) : (
                                <span className="admin-note">No linked account (legacy)</span>
                              )}
                            </span>
                          </td>
                          <td data-label="Offers">
                            <span className="admin-cell-body">
                              <span className="admin-cell-strong">
                                {request.offers.length}{' '}
                                {request.offers.length === 1 ? 'offer' : 'offers'}
                              </span>
                              <span className="admin-cell-sub">
                                {request.offers.length > 0
                                  ? request.offers.map((offer) => offer.technicianName).join(', ')
                                  : 'No offers yet'}
                              </span>
                            </span>
                          </td>
                          <td data-label="Created">
                            <span className="admin-cell-body">
                              {formatTimestamp(request.createdAt)}
                            </span>
                          </td>
                          <td data-label="Actions">
                            <span className="admin-cell-body">
                              <div className="admin-actions">
                                <button
                                  type="button"
                                  className="admin-action"
                                  aria-expanded={expanded}
                                  aria-controls={detailId}
                                  onClick={() => setExpandedId(expanded ? null : request.id)}
                                >
                                  {expanded ? 'Hide details' : 'Details'}
                                </button>
                              </div>
                            </span>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="admin-detail-row">
                            <td colSpan={7}>
                              <div className="admin-detail" id={detailId}>
                                <h2>
                                  {request.category} request · {request.city}
                                </h2>
                                <p className="admin-detail-desc">{request.description}</p>
                                {request.status === 'no_match' && (
                                  <p className="admin-note admin-note-warn">
                                    Dispatch finished without a match — this request remains
                                    unresolved.
                                  </p>
                                )}
                                <dl className="admin-detail-grid">
                                  <div>
                                    <dt>Request ID</dt>
                                    <dd className="admin-mono">{request.id}</dd>
                                  </div>
                                  <div>
                                    <dt>Status</dt>
                                    <dd>
                                      <RequestStatusBadge status={request.status} />
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Customer</dt>
                                    <dd>
                                      {request.customerEmail
                                        ? `${request.customerName} · ${request.customerEmail}`
                                        : 'Pre-authentication row — no linked account'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Created</dt>
                                    <dd>{formatTimestamp(request.createdAt)}</dd>
                                  </div>
                                  <div>
                                    <dt>Updated</dt>
                                    <dd>{formatTimestamp(request.updatedAt)}</dd>
                                  </div>
                                </dl>
                                <div className="admin-offers">
                                  <h3>Dispatch offers ({request.offers.length})</h3>
                                  {request.offers.length === 0 ? (
                                    <p className="admin-note">
                                      No offers were made on this request.
                                    </p>
                                  ) : (
                                    <ul>
                                      {request.offers.map((offer) => (
                                        <li key={offer.id}>
                                          <span className="admin-cell-strong">
                                            {offer.technicianName}
                                          </span>
                                          <OfferStatusBadge status={offer.status} />
                                          <small>{formatTimestamp(offer.createdAt)}</small>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
