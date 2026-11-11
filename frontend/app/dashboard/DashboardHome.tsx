'use client';

import { useAuth } from '@/lib/auth';
import AdminOverview from './AdminOverview';
import ConsumerDashboard from './ConsumerDashboard';
import TechnicianDashboard from './TechnicianDashboard';

/**
 * Role-aware dashboard body (Task 25 + follow-up pass).
 *
 * Reached only through RequireAuth (app/dashboard/page.tsx), so the
 * session is resolved and the role is authoritative before this mounts:
 *   - administrator → the real-data platform overview;
 *   - technician → the technician workbench (assignments + offers);
 *   - every other role → the customer dashboard.
 */
export default function DashboardHome() {
  const { user } = useAuth();
  if (user?.role === 'administrator') {
    return <AdminOverview />;
  }
  if (user?.role === 'technician') {
    return <TechnicianDashboard />;
  }
  return <ConsumerDashboard />;
}
