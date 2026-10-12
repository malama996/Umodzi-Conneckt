'use client';
import { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { divIcon, type DivIcon, type FitBoundsOptions, type Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  LuArrowRight,
  LuBriefcaseBusiness,
  LuClock,
  LuCrosshair,
  LuMapPin,
  LuRotateCcw,
  LuStar,
} from 'react-icons/lu';
import { VerifiedBadge } from '@/components/ui';
import { escapeHtml, formatDistanceKm, getMapViewBounds } from '@/lib/mapData';
import type { MapBounds, MapPoint, TechnicianMapMarker } from '@/lib/mapData';

/**
 * Technician map (V0.2 prototype) — a pure visualisation layer.
 *
 * Renders an OpenStreetMap Leaflet map with a distinct customer
 * marker and one marker per Smart Dispatch ranked technician.
 * The component performs no ranking, filtering, or matching of
 * its own; it only displays the data passed through props and
 * reports marker clicks back to the parent.
 *
 * All coordinates are mock/deterministic (see lib/mapData.ts).
 * Loaded client-only via next/dynamic (ssr: false) so Leaflet
 * browser APIs never run during server rendering.
 */

interface TechnicianMapProps {
  /** Where to show the customer/request marker (mock coordinates). */
  customerLocation: MapPoint;
  /** Label shown on the customer marker. */
  customerLabel: string;
  /** Ranked technicians from Smart Dispatch, already eligibility-filtered. */
  markers: TechnicianMapMarker[];
  /** Currently selected marker id (highlighted + centred from the list). */
  selectedMarkerId: string | null;
  /** Increments only when the user selects from the results list. */
  centerNonce: number;
  /** Whether the map pane is currently visible (drives fit/sizing). */
  visible: boolean;
  /** Called when a technician marker is clicked in the map. */
  onMarkerSelect: (id: string) => void;
}

const FIT_OPTIONS: FitBoundsOptions = { padding: [48, 48], maxZoom: 13 };

function fitToBounds(map: LeafletMap, bounds: MapBounds): void {
  map.fitBounds(
    [
      [bounds.south, bounds.west],
      [bounds.north, bounds.east],
    ],
    FIT_OPTIONS,
  );
}

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('');
}

/**
 * Keeps the map viewport in sync with dispatch results:
 * - fits the customer + technician markers when the marker set
 *   changes (deferred while the pane is hidden, then applied
 *   as soon as it is visible again);
 * - centres on the selected technician when the selection comes
 *   from the results list (centerNonce).
 * Uses refs for identity-only data so re-renders never undo the
 * user's own pan/zoom. No timers or artificial animation delays.
 */
function MapController({
  bounds,
  fitKey,
  selected,
  centerNonce,
  visible,
}: {
  bounds: MapBounds | null;
  fitKey: string;
  selected: TechnicianMapMarker | null;
  centerNonce: number;
  visible: boolean;
}) {
  const map = useMap();
  const boundsRef = useRef(bounds);
  const selectionRef = useRef<[number, number] | null>(null);
  const lastFitRef = useRef<string | null>(null);
  const pendingFitRef = useRef(true);

  // Track the freshest bounds/selection without re-triggering
  // the fit/centre effects below (refs are stable).
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);
  useEffect(() => {
    selectionRef.current = selected ? [selected.latitude, selected.longitude] : null;
  }, [selected]);

  useEffect(() => {
    if (fitKey !== lastFitRef.current) {
      pendingFitRef.current = true;
    }
    if (!visible) {
      return;
    }
    map.invalidateSize();
    const nextBounds = boundsRef.current;
    if (pendingFitRef.current && nextBounds) {
      fitToBounds(map, nextBounds);
      lastFitRef.current = fitKey;
      pendingFitRef.current = false;
    }
  }, [map, visible, fitKey]);

  useEffect(() => {
    if (centerNonce === 0) {
      return;
    }
    const target = selectionRef.current;
    if (target) {
      map.panTo(target);
    }
  }, [map, centerNonce]);

  return null;
}

/** Overlay controls: zoom is Leaflet's default; these add centre/fit. */
function MapControls({
  customerLocation,
  bounds,
}: {
  customerLocation: MapPoint;
  bounds: MapBounds | null;
}) {
  const map = useMap();
  return (
    <div className="map-controls" role="group" aria-label="Map controls">
      <button
        type="button"
        className="map-control"
        onClick={() => map.panTo([customerLocation.latitude, customerLocation.longitude])}
      >
        <LuCrosshair size={13} aria-hidden="true" /> Center on my location
      </button>
      <button
        type="button"
        className="map-control"
        onClick={() => {
          if (bounds) {
            fitToBounds(map, bounds);
          }
        }}
      >
        <LuRotateCcw size={13} aria-hidden="true" /> Fit to results
      </button>
    </div>
  );
}

export default function TechnicianMap({
  customerLocation,
  customerLabel,
  markers,
  selectedMarkerId,
  centerNonce,
  visible,
  onMarkerSelect,
}: TechnicianMapProps) {
  const bounds = useMemo(
    () => getMapViewBounds([customerLocation, ...markers]),
    [customerLocation, markers],
  );
  // Primitive key: only the marker SET changes refit behaviour —
  // identity-only data updates never reset the user's viewport.
  const fitKey = useMemo(
    () =>
      `${customerLocation.latitude},${customerLocation.longitude}|${markers
        .map((marker) => marker.id)
        .join(',')}`,
    [customerLocation, markers],
  );
  const selected = useMemo(
    () => markers.find((marker) => marker.id === selectedMarkerId) ?? null,
    [markers, selectedMarkerId],
  );

  const customerIcon = useMemo(
    () =>
      divIcon({
        className: 'map-pin-wrap',
        html: `<span class="map-pin map-pin-customer"><span class="map-pin-dot"></span><span class="map-pin-label">${escapeHtml(customerLabel)}</span></span>`,
        iconSize: [104, 44],
        iconAnchor: [52, 9],
      }),
    [customerLabel],
  );

  const technicianIcons: DivIcon[] = useMemo(
    () =>
      markers.map((marker) =>
        divIcon({
          className: 'map-pin-wrap',
          html: `<span class="map-pin map-pin-tech${marker.id === selectedMarkerId ? ' is-selected' : ''}"><span class="map-pin-dot">${escapeHtml(initialsOf(marker.name))}</span><span class="map-pin-label">${escapeHtml(marker.name)}</span></span>`,
          iconSize: [124, 54],
          iconAnchor: [62, 13],
        }),
      ),
    [markers, selectedMarkerId],
  );

  return (
    <div className="map-frame" role="region" aria-label="Nearby technicians map">
      <MapContainer
        center={[customerLocation.latitude, customerLocation.longitude]}
        zoom={12}
        className="technician-map"
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution={
            'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          }
        />
        <MapController
          bounds={bounds}
          fitKey={fitKey}
          selected={selected}
          centerNonce={centerNonce}
          visible={visible}
        />
        <MapControls customerLocation={customerLocation} bounds={bounds} />
        <Marker
          position={[customerLocation.latitude, customerLocation.longitude]}
          icon={customerIcon}
          zIndexOffset={1000}
        >
          <Popup className="map-popup">
            <div className="map-popup-body">
              <div className="map-popup-head">
                <h4>{customerLabel}</h4>
              </div>
              <p className="map-popup-sub">
                Mock location for this request (prototype — not real GPS).
              </p>
            </div>
          </Popup>
        </Marker>
        {markers.map((marker, index) => (
          <Marker
            key={marker.id}
            position={[marker.latitude, marker.longitude]}
            icon={technicianIcons[index]}
            eventHandlers={{ click: () => onMarkerSelect(marker.id) }}
          >
            <Popup className="map-popup">
              <div className="map-popup-body">
                <div className="map-popup-head">
                  <h4>{marker.name}</h4>
                  {marker.verified && <VerifiedBadge />}
                </div>
                <p className="map-popup-sub">
                  {marker.category} · {marker.serviceArea}
                </p>
                <div className="map-popup-meta">
                  <span>
                    <LuStar size={11} aria-hidden="true" /> {marker.rating}
                  </span>
                  <span>
                    <LuBriefcaseBusiness size={11} aria-hidden="true" /> {marker.jobs} jobs
                  </span>
                  <span>
                    <LuClock size={11} aria-hidden="true" /> {marker.availability}
                  </span>
                  <span>
                    <LuMapPin size={11} aria-hidden="true" /> {formatDistanceKm(marker.distanceKm)}
                  </span>
                </div>
                <Link
                  href={`/technicians/${encodeURIComponent(marker.name)}`}
                  className="outline-button map-popup-link"
                >
                  View Profile <LuArrowRight size={10} aria-hidden="true" />
                </Link>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
