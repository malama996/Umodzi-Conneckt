import RequireAuth from '@/components/RequireAuth';
import DashboardHome from './DashboardHome';

/**
 * /dashboard — the consumer dashboard for customers/technicians and the
 * administrator platform overview for administrators (Task 25). The route
 * itself stays server-rendered; DashboardHome switches by session role.
 */
export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardHome />
    </RequireAuth>
  );
}
