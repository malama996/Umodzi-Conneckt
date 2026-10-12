'use client';

import { useAuth } from '@/lib/auth';
import AdminOverview from './AdminOverview';
import ConsumerDashboard from './ConsumerDashboard';

/**
 * Role-aware dashboard body (Task 25).
 *
 * Reached only through RequireAuth (app/dashboard/page.tsx), so the
 * session is resolved and the role is authoritative before this mounts:
 *   - administrator → the real-data platform overview;
 *   - every other role → the original consumer dashboard, unchanged.
 */
export default function DashboardHome() {
  const { user } = useAuth();
  if (user?.role === 'administrator') {
    return <AdminOverview />;
  }
  return <ConsumerDashboard />;
}
