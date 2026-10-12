'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { LuArrowRight, LuSearch, LuWrench } from 'react-icons/lu';
import RequireAuth from '@/components/RequireAuth';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import {
  AvailabilityBadge,
  ProfileAccountBadge,
  VerificationBadge,
} from '@/components/admin/StatusBadge';
import { Badge, DashboardLayout } from '@/components/ui';
import { technicianCategories } from '@/lib/categories';
import type { AdminTechnician } from '@/lib/api/adminApi';
import {
  adminErrorMessage,
  fetchAdminTechnicians,
  filterAdminTechnicians,
  formatTimestamp,
  type TechnicianAccountFilter,
} from '@/lib/services/adminService';

/**
 * Administrator technician management (Task 25 §4) — /admin/technicians.
 *
 * Read-only visibility: name/identity, skills, service area, account,
 * availability, and verification status with search/filters, plus a full
 * profile detail expansion (and a public-profile link where one exists).
 * Verification changes and dispatch-side controls are deliberately NOT
 * here — verification refinement is Task 26 territory, and this screen
 * never touches dispatch eligibility. Server-side requireRole guards every
 * data call.
 */
export default function AdminTechniciansPage() {
  return (
    <RequireAuth role="administrator">
      <DashboardLayout active="Technicians">
        <AdminTechniciansView />
      </DashboardLayout>
    </RequireAuth>
  );
}

function AdminTechniciansView() {
  const [technicians, setTechnicians] = useState<AdminTechnician[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [account, setAccount] = useState<TechnicianAccountFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTechnicians(await fetchAdminTechnicians());
    } catch (err) {
      setTechnicians(null);
      setError(adminErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = filterAdminTechnicians(technicians ?? [], { search, category, status: account });

  const resetFilters = () => {
    setSearch('');
    setCategory('all');
    setAccount('all');
  };

  return (
    <main className="dashboard-page admin-page">
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow eyebrow-dark">ADMINISTRATOR</div>
          <h1>Technician management</h1>
          <p>Profiles, skills, service areas, availability, and verification at a glance.</p>
        </div>
        <Badge tone="teal">
          <LuWrench size={10} aria-hidden="true" />{' '}
          {technicians ? `${technicians.length} technicians` : 'Loading…'}
        </Badge>
      </div>

      {error ? (
        <AdminError message={error} onRetry={() => void load()} />
      ) : technicians === null ? (
        <AdminLoading label="Loading technicians…" />
      ) : (
        <>
          <div className="admin-toolbar">
            <label className="admin-search">
              <LuSearch aria-hidden="true" />
              <input
                type="search"
                placeholder="Search name, skills, area, email…"
                aria-label="Search technicians by name, skills, service area, or email"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span>Category</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="all">All categories</option>
                {technicianCategories.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Account status</span>
              <select
                value={account}
                onChange={(event) => setAccount(event.target.value as TechnicianAccountFilter)}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="suspended">Suspended</option>
              </select>
            </label>
          </div>

          <p className="admin-count" role="status">
            Showing {filtered.length} of {technicians.length}{' '}
            {technicians.length === 1 ? 'technician' : 'technicians'}
          </p>

          {filtered.length === 0 ? (
            <div className="admin-empty-block">
              {technicians.length === 0 ? (
                <AdminEmpty
                  title="No technicians registered yet."
                  hint="Technician accounts appear here as soon as they register."
                />
              ) : (
                <AdminEmpty
                  title="No technicians match this view."
                  hint="Adjust the search or filters to see more."
                />
              )}
              <button type="button" className="admin-action" onClick={resetFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <caption className="admin-table-caption">Technician profiles</caption>
                <thead>
                  <tr>
                    <th scope="col">Technician</th>
                    <th scope="col">Category & skills</th>
                    <th scope="col">Service area</th>
                    <th scope="col">Availability</th>
                    <th scope="col">Account</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tech) => {
                    const expanded = expandedId === tech.id;
                    const detailId = `technician-detail-${tech.id}`;
                    return (
                      <Fragment key={tech.id}>
                        <tr>
                          <td data-label="Technician">
                            <span className="admin-cell-body">
                              <span className="admin-cell-strong">{tech.name}</span>
                              <span className="admin-cell-sub">
                                {tech.userEmail ?? 'No linked account'}
                              </span>
                              <VerificationBadge verified={tech.verified} />
                            </span>
                          </td>
                          <td data-label="Category & skills">
                            <span className="admin-cell-body">
                              <span className="admin-cell-strong">{tech.category}</span>
                              <span className="admin-cell-sub">
                                {tech.skills.length > 0
                                  ? tech.skills.join(' · ')
                                  : 'No skills listed'}
                              </span>
                            </span>
                          </td>
                          <td data-label="Service area">
                            <span className="admin-cell-body">{tech.serviceArea}</span>
                          </td>
                          <td data-label="Availability">
                            <span className="admin-cell-body">
                              <AvailabilityBadge status={tech.availabilityStatus} />
                            </span>
                          </td>
                          <td data-label="Account">
                            <span className="admin-cell-body">
                              <ProfileAccountBadge status={tech.accountStatus} />
                            </span>
                          </td>
                          <td data-label="Joined">
                            <span className="admin-cell-body">
                              {formatTimestamp(tech.createdAt)}
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
                                  onClick={() => setExpandedId(expanded ? null : tech.id)}
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
                                <h2>{tech.name} — profile detail</h2>
                                <dl className="admin-detail-grid">
                                  <div>
                                    <dt>Profile ID</dt>
                                    <dd className="admin-mono">{tech.id}</dd>
                                  </div>
                                  <div>
                                    <dt>Skills</dt>
                                    <dd>{tech.skills.length > 0 ? tech.skills.join(', ') : '—'}</dd>
                                  </div>
                                  <div>
                                    <dt>Service area</dt>
                                    <dd>{tech.serviceArea}</dd>
                                  </div>
                                  <div>
                                    <dt>Availability</dt>
                                    <dd>
                                      {tech.availability} ({tech.availabilityStatus})
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Rating</dt>
                                    <dd>
                                      {tech.rating} · {tech.jobs} jobs
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Verification</dt>
                                    <dd>
                                      <VerificationBadge verified={tech.verified} />
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Linked account</dt>
                                    <dd>{tech.userEmail ?? 'None (prototype profile)'}</dd>
                                  </div>
                                  <div>
                                    <dt>Profile status</dt>
                                    <dd>
                                      <ProfileAccountBadge status={tech.accountStatus} />
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Created</dt>
                                    <dd>{formatTimestamp(tech.createdAt)}</dd>
                                  </div>
                                  <div>
                                    <dt>Updated</dt>
                                    <dd>{formatTimestamp(tech.updatedAt)}</dd>
                                  </div>
                                </dl>
                                <div className="admin-actions">
                                  <Link
                                    href={`/admin/technicians/${tech.id}`}
                                    className="outline-button"
                                  >
                                    Review verification{' '}
                                    <span>
                                      <LuArrowRight size={10} aria-hidden="true" />
                                    </span>
                                  </Link>
                                  <Link
                                    href={`/technicians/profile/${encodeURIComponent(tech.id)}`}
                                    className="outline-button"
                                  >
                                    View public profile{' '}
                                    <span>
                                      <LuArrowRight size={10} aria-hidden="true" />
                                    </span>
                                  </Link>
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
