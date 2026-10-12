'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { LuArrowLeft, LuArrowRight, LuClock, LuMapPin, LuStar } from 'react-icons/lu';
import { AdminEmpty, AdminError, AdminLoading } from '@/components/admin/AdminStates';
import { Badge, BrandAsset, PublicFooter, PublicHeader, VerifiedBadge } from '@/components/ui';
import { ApiError, apiBaseUrl } from '@/lib/api/client';
import { getTechnicianById } from '@/lib/api/techniciansApi';
import type { ApiTechnician } from '@/lib/api/techniciansApi';
import TechnicianReviewsSection from '@/components/TechnicianReviewsSection';

/**
 * Public technician profile for backend-registered technicians (Task 26
 * §18) — /technicians/profile/<id>.
 *
 * Renders REAL backend data only: photo (public photo endpoint), name,
 * bio, skills, category, service area, availability, verification badge
 * (driven by the real verified flag), rating and jobs. Verification
 * documents, rejection reasons, reviewer identity, and storage internals
 * are never part of this page. Prototype seed profiles keep their
 * mock-driven page at /technicians/[name] (Tasks 1/24 unchanged).
 */
export default function BackendTechnicianProfile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tech, setTech] = useState<ApiTechnician | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setMissing(false);
    try {
      const found = await getTechnicianById(id);
      if (!found) setMissing(true);
      setTech(found);
    } catch (err) {
      setTech(null);
      setError(
        err instanceof ApiError
          ? `Could not load this profile (HTTP ${err.status}).`
          : 'Could not load this profile.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const photoUrl =
    tech?.hasPhoto && tech.id
      ? `${apiBaseUrl()}/technicians/${encodeURIComponent(tech.id)}/photo`
      : null;

  return (
    <>
      <PublicHeader />
      <main className="profile-page">
        <div className="profile-wrap">
          <Link href="/matching" className="back-link">
            <LuArrowLeft size={11} className="ic" aria-hidden="true" /> Back to matches
          </Link>
          {missing ? (
            <AdminEmpty
              title="This technician profile does not exist."
              hint="It may have been removed, or the link is wrong."
            />
          ) : error ? (
            <AdminError message={error} onRetry={() => void load()} />
          ) : tech === null ? (
            <AdminLoading label="Loading technician profile…" />
          ) : (
            <section className="profile-card">
              <div className="profile-hero">
                {photoUrl ? (
                  <span className="profile-avatar profile-avatar-photo">
                    <BrandAsset
                      src={photoUrl}
                      alt={`${tech.name} profile photo`}
                      width={96}
                      height={96}
                    />
                  </span>
                ) : (
                  <div className="profile-avatar">
                    {tech.name
                      .split(' ')
                      .map((part) => part[0])
                      .join('')}
                  </div>
                )}
                <div>
                  <div className="eyebrow eyebrow-dark">TECHNICIAN PROFILE</div>
                  <h1>{tech.name}</h1>
                  <p>{[tech.category, ...tech.skills].join(' • ')}</p>
                  <div className="profile-badges">
                    {tech.verified && <VerifiedBadge />}
                    <Badge tone="success">
                      <LuClock size={10} aria-hidden="true" /> {tech.availability}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="profile-columns">
                <div>
                  <h2>Skills</h2>
                  <div className="skill-list">
                    {[tech.category, ...tech.skills].map((skill) => (
                      <span key={skill}>{skill}</span>
                    ))}
                  </div>
                  {tech.bio && (
                    <>
                      <h2>About</h2>
                      <p className="profile-about">{tech.bio}</p>
                    </>
                  )}
                  <h2>Service area</h2>
                  <p>
                    <LuMapPin size={12} className="ic" aria-hidden="true" /> {tech.serviceArea}
                  </p>
                </div>
                <aside>
                  {tech.verified && (
                    <BrandAsset
                      className="profile-art"
                      src="/illustrations/verified-technician.svg"
                      alt="Illustration: a verified Umodzi Connect technician profile"
                      width={640}
                      height={480}
                    />
                  )}
                  <div className="score">
                    <LuStar fill="currentColor" className="ic" aria-hidden="true" />{' '}
                    <b>{tech.rating}</b>
                    <span>rating</span>
                  </div>
                  <div className="jobs">
                    <b>{tech.jobs}</b>
                    <span>completed jobs</span>
                  </div>
                  <Link href="/matching" className="button button-coral">
                    Request this skill <LuArrowRight size={14} aria-hidden="true" />
                  </Link>
                </aside>
              </div>
            </section>
          )}
          {!missing && !error && tech !== null && <TechnicianReviewsSection technicianId={id} />}
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
