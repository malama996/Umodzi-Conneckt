import RequireAuth from '@/components/RequireAuth';
import PrivacySettings from '@/components/PrivacySettings';
import { DashboardLayout } from '@/components/ui';

/**
 * /dashboard/privacy — data access/export and permanent account deletion
 * (Task 28.3C, 28.3D). Behind RequireAuth; every action is authorised on the
 * server from the session, so this page is UX only.
 */
export default function PrivacySettingsPage() {
  return (
    <RequireAuth>
      <DashboardLayout active="Settings">
        <main className="dashboard-content">
          <PrivacySettings />
        </main>
      </DashboardLayout>
    </RequireAuth>
  );
}
