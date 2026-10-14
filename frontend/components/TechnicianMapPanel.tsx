'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  LuArrowRight,
  LuBriefcaseBusiness,
  LuClock,
  LuCrosshair,
  LuList,
  LuLoader,
  LuMap,
  LuMapPin,
  LuStar,
} from 'react-icons/lu';
import { VerifiedBadge } from '@/components/ui';
import {
  formatDistanceKm,
  toServiceAreaMarkers,
  type MapMarkerSource,
  type MapPoint,
} from '@/lib/mapData';
import { useGeolocation } from '@/lib/ui/useGeolocation';

/**
 * Technician map panel — the map + list view for a customer's service area
 * (production-fix Task 5).
 *
 * ---------------------------------------------------------------------------
 * What changed, and why the wording matters
 * ---------------------------------------------------------------------------
 * The map component itself (Leaflet + OpenStreetMap tiles, marker cleanup,
 * invalidateSize on show, mobile-friendly controls) already existed but was
 * mounted on NO screen, and every coordinate in it was a deterministic mock
 * value. Two things were wrong with that: the customer never saw a map at all,
 * and the copy described mock positions as if they were real.
 *
 * Now:
 *   * The customer's marker is the device's REAL position, and only after they
 *     tap "Use my location" — never on load (see useGeolocation). When the fix
 *     fails or is refused, the marker falls back to the SERVICE AREA THEY CHOSE
 *     and is labelled "Approx." — a coarser, honest position, never a silently
 *     invented GPS point.
 *   * Technician pins come from the LIVE platform listing (GET /technicians,
 *     passed in by the page) and mark the centre of each technician's declared
 *     service area. They are not live positions and the UI says so: the
 *     backend deliberately withholds precise technician coordinates from every
 *     public response, and a marketplace must not publish where a person is.
 *   * Distances are area-level (customer point → area centre) and labelled as
 *     such rather than presented as a distance to a person.
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
  /** Live technicians from the platform listing (already filtered by the page). */
  technicians: MapMarkerSource[];
  /** Where the map centres when no device location is shared. */
  fallbackLocation: MapPoint;
  /** Human name of that fallback area, e.g. "Kitwe". */
  fallbackLabel: string;
}

export default function TechnicianMapPanel({
  technicians,
  fallbackLocation,
  fallbackLabel,
}: TechnicianMapPanelProps) {
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [centerNonce, setCenterNonce] = useState(0);
  const geo = useGeolocation();

  const usingRealLocation = geo.position !== null;
  const customerLocation = geo.position ?? fallbackLocation;
  const customerLabel = usingRealLocation ? 'Your location' : `Approx. ${fallbackLabel}`;

  const markers = useMemo(
    () => toServiceAreaMarkers(technicians, customerLocation),
    [technicians, customerLocation],
  );

  // Selecting from the list also centres the map; selecting a marker only
  // highlights the matching card.
  const handleListSelect = (id: string) => {
    setSelectedId(id);
    setCenterNonce((previous) => previous + 1);
  };
  const handleMarkerSelect = (id: string) => setSelectedId(id);

  const countLabel = `${technicians.length} technician${technicians.length === 1 ? '' : 's'} listed`;

  if (technicians.length === 0) {
    return (
      <section className="map-section" aria-label="Nearby technicians map">
        <div className="result-head">
          <div>
            <span className="eyebrow eyebrow-dark">NEARBY TECHNICIANS</span>
            <h2>No available technicians</h2>
          </div>
          <span className="result-rule">Service-area locations</span>
        </div>
        <div className="dispatch-empty map-empty">
          <div className="request-created-icon dispatch-empty-icon">
            <LuMapPin size={28} aria-hidden="true" />
          </div>
          <h3>No technicians to show yet</h3>
          <p className="form-note">
            We couldn&apos;t find an available technician for this category right now. Try another
            category, or post your request and we will keep looking.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="map-section" aria-label="Technician locations map and list">
      <div className="result-head">
        <div>
          <span className="eyebrow eyebrow-dark">NEARBY TECHNICIANS</span>
          <h2>{countLabel}</h2>
        </div>
        <span className="result-rule">Service-area locations</span>
      </div>

      {/* Location permission (Task 5). Deliberately opt-in: the button states
          exactly what it is for, the state is announced, and the position is
          never requested on page load. */}
      <div className="map-location" role="status">
        <div className="map-location-text">
          <LuMapPin size={14} className="ic" aria-hidden="true" />
          <span>{geo.message}</span>
        </div>
        <div className="map-location-actions">
          {!usingRealLocation ? (
            <button
              type="button"
              className="outline-button"
              onClick={geo.request}
              disabled={geo.status === 'locating'}
            >
              <LuCrosshair size={13} className="ic" aria-hidden="true" />
              {geo.status === 'locating' ? 'Locating…' : 'Use my location'}
            </button>
          ) : (
            <button type="button" className="outline-button" onClick={geo.clear}>
              Stop using my location
            </button>
          )}
        </div>
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
          Pins mark each technician&apos;s service area centre, not a live position.
        </span>
      </div>

      <div className={`map-grid map-grid-${mode}`}>
        <div className="map-pane">
          <TechnicianMap
            customerLocation={customerLocation}
            customerLabel={customerLabel}
            markers={markers}
            selectedMarkerId={selectedId}
            centerNonce={centerNonce}
            visible={mode === 'map'}
            onMarkerSelect={handleMarkerSelect}
          />
          <p className="form-note map-disclaimer">
            {usingRealLocation
              ? `“${customerLabel}” is your device’s real position.`
              : `“${customerLabel}” is the centre of the service area you selected — share your location to place it on your real position.`}{' '}
            Technician pins show the centre of each declared service area, so distances are
            area-level estimates rather than distances to a person.
          </p>
        </div>

        <div className="map-results">
          {technicians.map((technician) => {
            const marker = markers.find((entry) => entry.id === technician.id);
            const isSelected = selectedId === technician.id;
            return (
              <article
                key={technician.id}
                className={`map-result${isSelected ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="map-result-select"
                  aria-pressed={isSelected}
                  onClick={() => handleListSelect(technician.id)}
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
                          {formatDistanceKm(marker.distanceKm)} away (area)
                        </span>
                      )}
                      <span>
                        <LuClock size={10} aria-hidden="true" /> {technician.availability}
                      </span>
                    </span>
                  </span>
                </button>
                <div className="map-result-actions">
                  <Link
                    href={`/technicians/profile/${encodeURIComponent(technician.id)}`}
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
          {markers.length !== technicians.length && ` · ${markers.length} shown on map`}
        </span>
      </div>
    </section>
  );
}
