'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LuCircleAlert, LuSparkles } from 'react-icons/lu';
import RequireAuth from '@/components/RequireAuth';
import ServiceRequestForm from '@/components/ServiceRequestForm';
import TechnicianMapPanel from '@/components/TechnicianMapPanel';
import { PublicFooter, PublicHeader } from '@/components/ui';
import { getCustomerLocation } from '@/lib/mapData';
import { technicianCategories, type TechnicianCategory } from '@/lib/categories';
import { getTechnicians, type ApiTechnician } from '@/lib/api/techniciansApi';
import {
  classificationErrorMessage,
  classifyFault,
  type FaultSuggestion,
} from '@/lib/api/classifyApi';
import type { ServiceRequest } from '@/lib/types';

/** Real API listings and server-authoritative request dispatch only. */
function MatchingContent() {
  // Bounds mirror the backend request schema (min 8 / max 2000): the
  // textarea enforces the maximum via maxLength and the form validates
  // the minimum before review, so the server never sees a value the
  // client claimed was fine.
  const DESCRIPTION_MIN = 8;
  const DESCRIPTION_MAX = 2000;
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TechnicianCategory | ''>('');
  const [technicians, setTechnicians] = useState<ApiTechnician[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createdRequest, setCreatedRequest] = useState<ServiceRequest | null>(null);
  const trimmedLength = description.trim().length;
  const showShortHint = trimmedLength > 0 && trimmedLength < DESCRIPTION_MIN;

  /**
   * AI category suggestion (Task 33) — strictly opt-in and never
   * destructive. The description is never modified; a manual selection is
   * never silently replaced (the suggestion waits for an explicit accept).
   * A sequence guard drops stale responses so a slow reply cannot
   * overwrite a newer choice, and there are no automatic retries.
   */
  const [classifying, setClassifying] = useState(false);
  const [suggestion, setSuggestion] = useState<FaultSuggestion | null>(null);
  const [classifyError, setClassifyError] = useState('');
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  const classifySeq = useRef(0);
  const categoryRef = useRef(category);
  categoryRef.current = category;

  const suggestCategory = async () => {
    if (classifying || trimmedLength < DESCRIPTION_MIN) return;
    const seq = classifySeq.current + 1;
    classifySeq.current = seq;
    setClassifying(true);
    setClassifyError('');
    setSuggestion(null);
    setAppliedNote(null);
    try {
      const result = await classifyFault(description.trim());
      if (classifySeq.current !== seq) return;
      const current = categoryRef.current;
      if (current === '') {
        setCategory(result.category);
        setAppliedNote(
          `Suggested by AI${result.summary ? ` — ${result.summary}` : ''}. You can change it.`,
        );
      } else if (current === result.category) {
        setAppliedNote('AI agrees with the category you chose.');
      } else {
        setSuggestion(result);
      }
    } catch (error) {
      if (classifySeq.current !== seq) return;
      setClassifyError(classificationErrorMessage(error));
    } finally {
      if (classifySeq.current === seq) setClassifying(false);
    }
  };

  const acceptSuggestion = () => {
    if (!suggestion) return;
    setCategory(suggestion.category);
    setAppliedNote(
      `Suggested by AI${suggestion.summary ? ` — ${suggestion.summary}` : ''}. You can change it.`,
    );
    setSuggestion(null);
  };

  useEffect(() => {
    let active = true;
    void getTechnicians()
      .then((rows) => {
        if (active) setTechnicians(rows);
      })
      .catch(() => {
        if (active)
          setLoadError('Technician listings are temporarily unavailable. Please try again.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleTechnicians = useMemo(
    () =>
      technicians.filter(
        (technician) =>
          technician.accountStatus === 'active' &&
          technician.availabilityStatus === 'available' &&
          (category === '' || technician.category === category),
      ),
    [category, technicians],
  );

  /**
   * Honest fallback centre for the map (Task 5): the service area the customer
   * chose for this request, or the pilot default before a request exists. It is
   * used ONLY until the customer shares their device location, and the panel
   * labels it "Approx." so a fallback is never mistaken for a GPS fix.
   */
  const fallbackCity = createdRequest?.city ?? 'Kitwe';

  return (
    <>
      <PublicHeader />
      <main className="matching-page">
        <div className="matching-hero">
          <div>
            <div className="eyebrow">SERVICE REQUESTS</div>
            <h1>Tell us what needs fixing.</h1>
            <p>Eligible verified technicians are selected by the server and notified securely.</p>
          </div>
        </div>
        <div className="matching-layout">
          <section className="match-form-panel" aria-label="Create service request">
            <label htmlFor="fault-description">
              <span>Describe the problem</span>
              <textarea
                id="fault-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={DESCRIPTION_MAX}
                rows={5}
                aria-describedby="fault-description-hint fault-description-count"
                placeholder="Example: Kitchen sink cold tap drips constantly since Tuesday and the cupboard floor underneath is damp. Mixer tap, unknown brand — no error display."
              />
            </label>
            <p id="fault-description-hint" className="fault-hint">
              Include the symptoms, when the problem started, the equipment or device involved, and
              any error messages you see. At least {DESCRIPTION_MIN} characters helps a technician
              diagnose the fault.
            </p>
            <div className="fault-meta">
              <span id="fault-description-count" className="fault-count" role="status">
                {description.length} / {DESCRIPTION_MAX} characters
              </span>
              {showShortHint && (
                <span className="fault-short">
                  A little more detail helps — {DESCRIPTION_MIN - trimmedLength} more{' '}
                  {DESCRIPTION_MIN - trimmedLength === 1 ? 'character' : 'characters'} needed.
                </span>
              )}
            </div>
            <label>
              <span>Service category</span>
              <select
                value={category}
                onChange={(event) => {
                  // An explicit manual choice always wins: it dismisses any
                  // pending AI suggestion or note rather than fighting it.
                  setCategory(event.target.value as TechnicianCategory | '');
                  setSuggestion(null);
                  setAppliedNote(null);
                }}
              >
                <option value="">Select a category</option>
                {technicianCategories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <div className="ai-suggest">
              <button
                type="button"
                className="outline-button ai-suggest-button"
                onClick={() => void suggestCategory()}
                disabled={classifying || trimmedLength < DESCRIPTION_MIN}
              >
                <LuSparkles size={12} className="ic" aria-hidden="true" />{' '}
                {classifying ? 'Classifying…' : 'Suggest a category with AI'}
              </button>
              {appliedNote && (
                <p className="ai-note" role="status">
                  {appliedNote}
                </p>
              )}
              {suggestion && (
                <div className="ai-suggestion" role="status">
                  <p>
                    AI suggests <b>{suggestion.category}</b>
                    {suggestion.summary ? ` — ${suggestion.summary}` : ''}. Your selection stays
                    until you accept.
                  </p>
                  <div className="ai-suggestion-actions">
                    <button
                      type="button"
                      className="button button-coral button-small"
                      onClick={acceptSuggestion}
                    >
                      Use suggestion
                    </button>
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => setSuggestion(null)}
                    >
                      Keep {category || 'my choice'}
                    </button>
                  </div>
                </div>
              )}
              {classifyError && (
                <p className="request-form-error" role="alert">
                  <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {classifyError}
                </p>
              )}
            </div>
            <ServiceRequestForm
              description={description}
              category={category}
              onRequestCreated={setCreatedRequest}
              onRequestReset={() => setCreatedRequest(null)}
            />
            {createdRequest && (
              <p className="form-note" role="status">
                Request status: <strong>{createdRequest.status}</strong>. You will receive an in-app
                notification when a technician responds.
              </p>
            )}
          </section>

          {/* Live listing + location map (Task 5). The map panel owns the
              technician list as well, so the same technicians are never
              rendered twice. Every row and pin is real platform data; only
              the customer marker becomes a GPS fix, and only on request. */}
          <section id="matches" aria-live="polite">
            {loadError ? (
              <p className="request-form-error" role="alert">
                <LuCircleAlert size={12} className="ic" aria-hidden="true" /> {loadError}
              </p>
            ) : loading ? (
              <p className="panel-sub" role="status">
                Loading technicians…
              </p>
            ) : (
              <TechnicianMapPanel
                technicians={visibleTechnicians}
                fallbackLocation={getCustomerLocation(fallbackCity)}
                fallbackLabel={fallbackCity}
              />
            )}
          </section>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}

export default function MatchingPage() {
  return (
    <RequireAuth role="customer">
      <MatchingContent />
    </RequireAuth>
  );
}
