import RequireAuth from '@/components/RequireAuth';
import NotificationInbox from '@/components/NotificationInbox';
import { DashboardLayout } from '@/components/ui';

/**
 * /dashboard/notifications — the data subject's own notification history
 * (Task 28.3C, closing gap G-02).
 *
 * Previously the application persisted notifications and pushed them to
 * devices but offered NO way for a person to read their own history. This page
 * is that surface, backed by the owner-scoped API.
 */
export default function NotificationsPage() {
  return (
    <RequireAuth>
      <DashboardLayout active="Notifications">
        <main className="dashboard-content">
          <NotificationInbox />
        </main>
      </DashboardLayout>
    </RequireAuth>
  );
}
