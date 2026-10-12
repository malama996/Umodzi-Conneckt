'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { LuSearch, LuUsers } from 'react-icons/lu';
import RequireAuth from '@/components/RequireAuth';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import { AccountStatusBadge, RoleBadge } from '@/components/admin/StatusBadge';
import { Badge, DashboardLayout } from '@/components/ui';
import { notifyError, notifySuccess } from '@/lib/notifications/store';
import { useAuth } from '@/lib/auth';
import type { AccountStatus, UserRole } from '@/lib/auth/authTypes';
import type { AdminUser } from '@/lib/api/adminApi';
import {
  adminErrorMessage,
  fetchAdminUsers,
  filterAdminUsers,
  formatTimestamp,
  setUserAccountStatus,
} from '@/lib/services/adminService';

/** Next-status choices per current status (a status can always change). */
const NEXT_STATUSES: Record<AccountStatus, AccountStatus[]> = {
  active: ['suspended', 'disabled'],
  suspended: ['active', 'disabled'],
  disabled: ['active', 'suspended'],
};

const VERBS: Record<AccountStatus, string> = {
  active: 'Activate',
  suspended: 'Suspend',
  disabled: 'Disable',
};

const IMPACT: Record<AccountStatus, string> = {
  active: 'The account will be able to sign in again.',
  suspended: 'The account will be suspended and cannot sign in until reactivated.',
  disabled: 'The account will be disabled and cannot sign in until reactivated.',
};

/**
 * Administrator user management (Task 25 §3) — /admin/users.
 *
 * Server-authorized end to end: RequireAuth gates the route for UX, and
 * every data call plus the status mutation is enforced by
 * `requireRole('administrator')` on the backend (403 for everyone else).
 * Deactivation goes through an inline confirmation and a PATCH that
 * refuses self-changes (403) — there is no delete affordance anywhere,
 * because the platform has no destructive user operation.
 */
export default function AdminUsersPage() {
  return (
    <RequireAuth role="administrator">
      <DashboardLayout active="Users">
        <AdminUsersView />
      </DashboardLayout>
    </RequireAuth>
  );
}

function AdminUsersView() {
  const { user: sessionUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<UserRole | 'all'>('all');
  const [status, setStatus] = useState<AccountStatus | 'all'>('all');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    target: AdminUser;
    next: AccountStatus;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await fetchAdminUsers());
    } catch (err) {
      setUsers(null);
      setError(adminErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = filterAdminUsers(users ?? [], { search, role, status });

  const resetFilters = () => {
    setSearch('');
    setRole('all');
    setStatus('all');
  };

  const commit = async () => {
    if (!confirming) return;
    const { target, next } = confirming;
    setPendingId(target.id);
    setActionError(null);
    try {
      const updated = await setUserAccountStatus(target.id, next);
      setUsers((list) => (list ? list.map((u) => (u.id === updated.id ? updated : u)) : list));
      setConfirming(null);
      notifySuccess({
        title: 'Account status updated',
        message: `${updated.email} is now ${updated.accountStatus}.`,
      });
    } catch (err) {
      const message = adminErrorMessage(err);
      setConfirming(null);
      setActionError(message);
      notifyError({ title: 'Could not update account status', message });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <main className="dashboard-page admin-page">
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow eyebrow-dark">ADMINISTRATOR</div>
          <h1>User management</h1>
          <p>Every registered account — identity, role, and account status.</p>
        </div>
        <Badge tone="teal">
          <LuUsers size={10} aria-hidden="true" /> {users ? `${users.length} accounts` : 'Loading…'}
        </Badge>
      </div>

      {error ? (
        <AdminError message={error} onRetry={() => void load()} />
      ) : users === null ? (
        <AdminLoading label="Loading users…" />
      ) : (
        <>
          <div className="admin-toolbar">
            <label className="admin-search">
              <LuSearch aria-hidden="true" />
              <input
                type="search"
                placeholder="Search name or email…"
                aria-label="Search users by name or email"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span>Role</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole | 'all')}
              >
                <option value="all">All roles</option>
                <option value="customer">Customer</option>
                <option value="technician">Technician</option>
                <option value="administrator">Administrator</option>
              </select>
            </label>
            <label className="admin-field">
              <span>Account status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as AccountStatus | 'all')}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
          </div>

          <p className="admin-count" role="status">
            Showing {filtered.length} of {users.length}{' '}
            {users.length === 1 ? 'account' : 'accounts'}
          </p>
          {actionError && (
            <p className="admin-inline-error" role="alert">
              {actionError}
            </p>
          )}

          {filtered.length === 0 ? (
            <div className="admin-empty-block">
              {users.length === 0 ? (
                <AdminEmpty
                  title="No accounts yet."
                  hint="Registered customers and technicians will appear here."
                />
              ) : (
                <AdminEmpty
                  title="No accounts match this view."
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
                <caption className="admin-table-caption">Registered user accounts</caption>
                <thead>
                  <tr>
                    <th scope="col">User</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((account) => {
                    const isSelf = sessionUser?.id === account.id;
                    return (
                      <Fragment key={account.id}>
                        <tr>
                          <td data-label="User">
                            <span className="admin-cell-strong">
                              {account.firstName} {account.lastName}
                            </span>
                            <span className="admin-cell-sub">{account.email}</span>
                          </td>
                          <td data-label="Role">
                            <RoleBadge role={account.role} />
                          </td>
                          <td data-label="Status">
                            <AccountStatusBadge status={account.accountStatus} />
                          </td>
                          <td data-label="Joined">{formatTimestamp(account.createdAt)}</td>
                          <td data-label="Actions">
                            {isSelf ? (
                              <span className="admin-note">Own account</span>
                            ) : (
                              <div className="admin-actions">
                                {NEXT_STATUSES[account.accountStatus].map((next) => (
                                  <button
                                    key={next}
                                    type="button"
                                    className="admin-action"
                                    aria-label={`${VERBS[next]} ${account.email}`}
                                    disabled={pendingId !== null}
                                    onClick={() => {
                                      setActionError(null);
                                      setConfirming({ target: account, next });
                                    }}
                                  >
                                    {VERBS[next]}
                                  </button>
                                ))}
                                {pendingId === account.id && (
                                  <span className="admin-note" role="status">
                                    Saving…
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                        {confirming?.target.id === account.id && (
                          <tr className="admin-confirm-row">
                            <td colSpan={5}>
                              <div className="admin-confirm" role="status">
                                <p>
                                  <b>
                                    {VERBS[confirming.next]} {confirming.target.email}?
                                  </b>{' '}
                                  {IMPACT[confirming.next]}
                                  {confirming.target.role === 'technician' &&
                                    ' The linked technician profile status will follow.'}
                                </p>
                                <div className="admin-confirm-actions">
                                  <button
                                    type="button"
                                    className="admin-action admin-action-confirm"
                                    disabled={pendingId !== null}
                                    onClick={() => void commit()}
                                  >
                                    {pendingId !== null ? 'Saving…' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    className="admin-action"
                                    disabled={pendingId !== null}
                                    onClick={() => setConfirming(null)}
                                  >
                                    Cancel
                                  </button>
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

      <p className="admin-footnote">
        Account changes are authorized on the server. Passwords, sessions, and tokens are never
        shown or editable here.
      </p>
    </main>
  );
}
