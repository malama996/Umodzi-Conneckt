'use client';

import { LuCircleAlert, LuInbox } from 'react-icons/lu';
import { Button } from '@/components/ui';

/**
 * Shared loading / error / empty states for the Task 25 administrator
 * screens. Every admin data view renders exactly one of these while its
 * fetch is pending, failed, or returning zero rows — no screen ever shows
 * fabricated placeholder content, and errors always offer a retry.
 */

export function AdminLoading({ label }: { label: string }) {
  return (
    <p className="admin-state" role="status">
      {label}
    </p>
  );
}

export function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="admin-error" role="alert">
      <p>
        <LuCircleAlert size={14} aria-hidden="true" /> {message}
      </p>
      <Button type="button" className="button-coral button-small" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function AdminEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="admin-empty">
      <span className="admin-empty-icon" aria-hidden="true">
        <LuInbox size={22} />
      </span>
      <p>{title}</p>
      {hint && <small>{hint}</small>}
    </div>
  );
}
