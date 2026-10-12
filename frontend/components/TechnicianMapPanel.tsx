'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  LuArrowRight,
  LuBriefcaseBusiness,
  LuClock,
  LuList,
  LuLoader,
  LuMap,
  LuMapPin,
  LuStar,
} from 'react-icons/lu';
import { VerifiedBadge } from '@/components/ui';
import { formatDistanceKm, getCustomerLocation, toTechnicianMapMarkers } from '@/lib/mapData';
import type { RankedTechnician } from '@/lib/types';

/**
 * Technician map panel (V0.2 prototype).
 *
 * Wraps the client-only TechnicianMap with the surrounding
 * page UI: header, Map/List toggle, ranked results list, and
 * the empty state. It receives the Smart Dispatch ranked
 * candidates directly — it never ranks or filters technicians
 * itself. Card ↔ marker selection is local UI state only.
 *
 * All coordinates are mock/deterministic (see lib/mapData.ts).
 */

const TechnicianMap = dynamic(() => import('@/components/TechnicianMap'), {
  ssr: false,
  loading: () => (
    <div className="map-loading" role="status">
      <LuLoader size={15} className="ic dispatch-spin" aria-hidden="true" />
      <span>Loading map…</span>
    </div>
  ),
});

interface TechnicianMapPanelProps {
  /** Request city — used only to derive the mock customer location. */
  city: string;
  /** Smart Dispatch ranked candidates, passed through unchanged. */
  ranked: RankedTechnician[];
}

export default function TechnicianMapPanel({ city, ranked }: TechnicianMapPanelProps) {
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [centerNonce, setCenterNonce] = useState(0);

  const customerLocation = useMemo(() => getCustomerLocation(city), [city]);
  const markers = useMemo(
    () => toTechnicianMapMarkers(ranked, customerLocation),
    [ranked, customerLocation],
  );

  // Selecting from the list also centres the map; selecting from
  // a marker only highlights the matching card.
  const handleListSelect = (name: string) => {
    setSelectedName(name);
    setCenterNonce((previous) => previous + 1);
  };
  const handleMarkerSelect = (name: string) => setSelectedName(name);

  const countLabel = `${ranked.length} technician${ranked.length === 1 ? '' : 's'} found`;

  if (ranked.length === 0) {
    return (
      <section className="map-section" aria-label="Nearby technicians map">
        <div className="result-head">
          <div>
            <span className="eyebrow eyebrow-dark">NEARBY TECHNICIANS</span>
            <h2>{countLabel}</h2>
          </div>
          <span className="result-rule">Smart Dispatch ranking</span>
        </div>
        <div className="dispatch-empty map-empty">
          <div className="request-created-icon dispatch-empty-icon">
            <LuMapPin size={28} aria-hidden="true" />
          </div>
          <h3>No nearby technicians found</h3>
          <p className="form-note">
            We couldn&apos;t find an eligible technician for this request. Try expanding your
            service area or changing the request details.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="map-section" aria-label="Nearby technicians map and list">
      <div className="result-head">
        <div>
          <span className="eyebrow eyebrow-dark">NEARBY TECHNICIANS</span>
          <h2>{countLabel}</h2>
        </div>
        <span className="result-rule">Smart Dispatch ranking</span>
      </div>

      <div className="map-toolbar">
        <div className="map-toggle" role="group" aria-label="Choose map or list view">
          <button
            type="button"
            className={`map-toggle-btn${mode === 'map' ? ' is-active' : ''}`}
            aria-pressed={mode === 'map'}
            onClick={() => setMode('map')}
          >
            <LuMap size={12} aria-hidden="true" /> Map
          </button>
          <button
            type="button"
            className={`map-toggle-btn${mode === 'list' ? ' is-active' : ''}`}
            aria-pressed={mode === 'list'}
            onClick={() => setMode('list')}
          >
            <LuList size={12} aria-hidden="true" /> List
          </button>
        </div>
        <span className="form-note map-toolbar-note">
          Map markers mirror the Smart Dispatch ranking — no second matching pass.
        </span>
      </div>

      <div className={`map-grid map-grid-${mode}`}>
        <div className="map-pane">
          <TechnicianMap
            customerLocation={customerLocation}
            customerLabel="Your location"
            markers={markers}
            selectedMarkerId={selectedName}
            centerNonce={centerNonce}
            visible={mode === 'map'}
            onMarkerSelect={handleMarkerSelect}
          />
          <p className="form-note map-disclaimer">
            Prototype: “Your location” is a deterministic mock coordinate for {city} — not your real
            GPS position. Technician pins use mock coordinates around each service area, not real
            technician locations.
          </p>
        </div>

        <div className="map-results">
          {ranked.map((rankedItem, index) => {
            const technician = rankedItem.technician;
            const marker = markers.find((entry) => entry.id === technician.name);
            const isSelected = selectedName === technician.name;
            return (
              <article
                key={technician.name}
                className={`map-result${isSelected ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="map-result-select"
                  aria-pressed={isSelected}
                  onClick={() => handleListSelect(technician.name)}
                >
                  <span className="avatar" aria-hidden="true">
                    {technician.name
                      .split(' ')
                      .map((part) => part[0])
                      .join('')}
                  </span>
                  <span className="map-result-info">
                    <span className="map-result-name">
                      <b>{technician.name}</b>
                      {technician.verified && <VerifiedBadge />}
                      {isSelected && <span className="map-result-chip">Selected</span>}
                    </span>
                    <span className="map-result-cat">
                      {[technician.category, technician.serviceArea].join(' · ')}
                    </span>
                    <span className="map-result-meta">
                      <span>
                        <LuStar size={10} aria-hidden="true" /> {technician.rating}
                      </span>
                      <span>
                        <LuBriefcaseBusiness size={10} aria-hidden="true" /> {technician.jobs} jobs
                      </span>
                      {marker && (
                        <span>
                          <LuMapPin size={10} aria-hidden="true" />{' '}
                          {formatDistanceKm(marker.distanceKm)}
                        </span>
                      )}
                      <span>
                        <LuClock size={10} aria-hidden="true" /> {technician.availability}
                      </span>
                    </span>
                    <span className="map-result-rank">Ranked candidate {index + 1}</span>
                  </span>
                </button>
                <div className="map-result-actions">
                  <Link
                    href={`/technicians/${encodeURIComponent(technician.name)}`}
                    className="outline-button"
                  >
                    View Profile <LuArrowRight size={10} aria-hidden="true" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="map-footer" role="status">
        <LuMapPin size={12} className="ic" aria-hidden="true" />
        <span>
          {countLabel}
          {markers.length !== ranked.length && ` · ${markers.length} shown on map`}
        </span>
      </div>
    </section>
  );
}
