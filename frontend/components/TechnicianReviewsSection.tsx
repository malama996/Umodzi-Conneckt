'use client';

import { useCallback, useEffect, useState } from 'react';
import { LuStar } from 'react-icons/lu';
import { AdminError, AdminLoading } from '@/components/admin/AdminStates';
import type { TechnicianReviews } from '@/lib/api/reviewsApi';
import { formatTimestamp } from '@/lib/services/adminService';
import { fetchTechnicianReviews, ratingLabel } from '@/lib/services/reviewService';

/**
 * Shared "Ratings & Reviews" section (Task 27 §12–§14) used by the public
 * technician profile, the technician's own profile, and the admin review
 * page. Everything is computed server-side: average (1 decimal), review
 * count, star distribution, and the real review list — nothing is
 * hard-coded and there are no seeded reviews. The verified badge is a
 * SEPARATE trust signal and never rendered here (§15).
 */
export default function TechnicianReviewsSection({
  technicianId,
  heading = 'Ratings & Reviews',
}: {
  technicianId: string;
  heading?: string;
}) {
  const [data, setData] = useState<TechnicianReviews | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchTechnicianReviews(technicianId));
    } catch {
      setData(null);
      setError('Ratings and reviews are unavailable right now.');
    }
  }, [technicianId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="t27-reputation" aria-label="Ratings and reviews">
      <div className="eyebrow eyebrow-dark">RATINGS &amp; REVIEWS</div>
      <h2>{heading}</h2>

      {error ? (
        <AdminError message={error} onRetry={() => void load()} />
      ) : data === null ? (
        <AdminLoading label="Loading ratings…" />
      ) : (
        <>
          <div className="t27-rep-summary">
            <div className="t27-rep-average">
              <span className="t27-rep-number">
                {data.summary.average === null ? '—' : data.summary.average.toFixed(1)}
              </span>
              <div>
                <span
                  className="t27-stars"
                  aria-label={
                    data.summary.average === null
                      ? 'No ratings yet'
                      : `Average rating ${data.summary.average.toFixed(1)} out of 5`
                  }
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <LuStar
                      key={n}
                      size={16}
                      aria-hidden="true"
                      fill={
                        data.summary.average !== null && n <= Math.round(data.summary.average)
                          ? 'currentColor'
                          : 'none'
                      }
                    />
                  ))}
                </span>
                <p className="t27-rep-count">
                  {data.summary.count} review{data.summary.count === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            {data.summary.count > 0 && (
              <div className="t27-dist" aria-label="Rating distribution">
                {[5, 4, 3, 2, 1].map((n) => {
                  const count = data.summary.distribution[String(n) as '1' | '2' | '3' | '4' | '5'];
                  const width =
                    data.summary.count === 0 ? 0 : Math.round((count / data.summary.count) * 100);
                  return (
                    <div className="t27-dist-row" key={n}>
                      <span className="t27-dist-star">{n} ★</span>
                      <span className="t27-dist-track">
                        <span className="t27-dist-fill" style={{ width: `${width}%` }} />
                      </span>
                      <span className="t27-dist-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {data.reviews.length === 0 ? (
            <p className="t27-empty">
              No reviews yet. Be the first customer to share your experience.
            </p>
          ) : (
            <ul className="t27-review-list">
              {data.reviews.map((review) => (
                <li key={review.id} className="t27-review-item">
                  <div className="t27-review-meta">
                    <span
                      className="t27-stars"
                      aria-label={`${review.rating} of 5 — ${ratingLabel(review.rating)}`}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <LuStar
                          key={n}
                          size={14}
                          aria-hidden="true"
                          fill={n <= review.rating ? 'currentColor' : 'none'}
                        />
                      ))}
                    </span>
                    <span className="t27-review-author">{review.customerName}</span>
                    <span className="t27-review-date">{formatTimestamp(review.createdAt)}</span>
                  </div>
                  {review.comment && <p className="t27-review-comment">{review.comment}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
