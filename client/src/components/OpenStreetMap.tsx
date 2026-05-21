import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { EventDetails, LocationPin } from "../lib/types";
import {
  clampLatitude,
  clampZoom,
  DEFAULT_LOCATION_PIN,
  formatCoordinate,
  latLngToWorld,
  mapTiles,
  normalizeLocationPin,
  openStreetMapUrl,
  worldToLatLng,
  wrapLongitude
} from "../lib/map";

type SearchResult = {
  display_name: string;
  lat: string;
  lon: string;
};

type MapSize = {
  width: number;
  height: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startWorld: ReturnType<typeof latLngToWorld>;
  zoom: number;
  moved: boolean;
};

export function LocationMap({ pin, editable = false, onChange }: { pin?: LocationPin; editable?: boolean; onChange?: (pin: LocationPin) => void }) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const [size, setSize] = useState<MapSize>({ width: 640, height: 320 });
  const [dragging, setDragging] = useState(false);
  const activePin = normalizeLocationPin(pin);
  const tiles = useMemo(() => mapTiles(activePin, size.width, size.height), [activePin.lat, activePin.lng, activePin.zoom, size.width, size.height]);

  useEffect(() => {
    if (!mapRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(1, entry.contentRect.width),
        height: Math.max(1, entry.contentRect.height)
      });
    });
    observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, []);

  function pinAtPointer(event: PointerEvent<HTMLDivElement>) {
    if (!editable || !onChange) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const center = latLngToWorld(activePin);
    onChange(worldToLatLng({
      x: center.x + event.clientX - rect.left - rect.width / 2,
      y: center.y + event.clientY - rect.top - rect.height / 2
    }, activePin.zoom));
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!editable || !onChange) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWorld: latLngToWorld(activePin),
      zoom: activePin.zoom,
      moved: false
    };
    setDragging(true);
  }

  function dragMap(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !onChange || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    onChange(worldToLatLng({
      x: drag.startWorld.x - dx,
      y: drag.startWorld.y - dy
    }, drag.zoom));
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) pinAtPointer(event);
    dragRef.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      className={`osm-map${editable ? " editable" : ""}${dragging ? " dragging" : ""}`}
      ref={mapRef}
      onPointerDown={startDrag}
      onPointerMove={dragMap}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <div className="osm-tiles" aria-hidden="true">
        {tiles.map((tile) => (
          <img
            alt=""
            draggable={false}
            key={tile.key}
            src={tile.url}
            style={{ left: `${tile.left}px`, top: `${tile.top}px` }}
          />
        ))}
      </div>
      <div className="map-pin" aria-label={`Pinned at ${formatCoordinate(activePin.lat)}, ${formatCoordinate(activePin.lng)}`} />
      <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" onPointerDown={(event) => event.stopPropagation()}>
        OpenStreetMap
      </a>
    </div>
  );
}

function shortPlaceName(result: SearchResult): string {
  const parts = result.display_name.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3 && /^\d+[a-z]?$/i.test(parts[1])) {
    return `${parts[0]}, ${parts[1]} ${parts[2]}`;
  }
  return parts.slice(0, 2).join(", ").trim();
}

export function MapPinEditor({
  details,
  onChange,
  onVenueChange
}: {
  details: EventDetails;
  onChange: (pin: LocationPin | undefined) => void;
  onVenueChange: (location: string) => void;
}) {
  const activePin = normalizeLocationPin(details.locationPin);
  const [query, setQuery] = useState(details.location);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setQuery(details.location);
  }, [details.location]);

  async function search() {
    const text = query.trim();
    if (!text) return;
    setStatus("Searching OpenStreetMap");
    setResults([]);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(text)}`);
      if (!response.ok) throw new Error(`OpenStreetMap search failed: ${response.status}`);
      const nextResults = await response.json() as SearchResult[];
      setResults(nextResults);
      setStatus(nextResults.length ? "" : "No OpenStreetMap matches");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenStreetMap search failed");
    }
  }

  function updateCoordinate(key: "lat" | "lng", value: string) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return;
    onChange({
      ...activePin,
      [key]: key === "lat" ? clampLatitude(numberValue) : wrapLongitude(numberValue)
    });
  }

  function updateZoom(delta: number) {
    onChange({ ...activePin, zoom: clampZoom(activePin.zoom + delta) });
  }

  function chooseResult(result: SearchResult) {
    const location = shortPlaceName(result);
    onVenueChange(location);
    setQuery(location);
    onChange({
      lat: clampLatitude(Number(result.lat)),
      lng: wrapLongitude(Number(result.lon)),
      zoom: Math.max(activePin.zoom, DEFAULT_LOCATION_PIN.zoom)
    });
    setResults([]);
    setStatus("");
  }

  return (
    <section className="map-editor">
      <div className="section-heading">
        <h3>Map pin</h3>
        <span>{formatCoordinate(activePin.lat)}, {formatCoordinate(activePin.lng)}</span>
      </div>
      <div className="map-search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search OpenStreetMap" />
        <button className="secondary" type="button" onClick={search}>Search</button>
      </div>
      {status ? <p className="tiny map-status">{status}</p> : null}
      {results.length ? (
        <div className="map-results">
          {results.map((result) => (
            <button key={`${result.lat}-${result.lon}-${result.display_name}`} type="button" onClick={() => chooseResult(result)}>
              <strong>{shortPlaceName(result)}</strong>
              <span>{result.display_name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="map-picker">
        <LocationMap pin={activePin} editable onChange={onChange} />
        <div className="map-tools" onPointerDown={(event) => event.stopPropagation()}>
          <button className="secondary icon-button" type="button" onClick={() => updateZoom(1)} aria-label="Zoom in">+</button>
          <button className="secondary icon-button" type="button" onClick={() => updateZoom(-1)} aria-label="Zoom out">−</button>
        </div>
      </div>
      <div className="coordinate-grid">
        <label>Latitude<input value={formatCoordinate(activePin.lat)} onChange={(event) => updateCoordinate("lat", event.target.value)} /></label>
        <label>Longitude<input value={formatCoordinate(activePin.lng)} onChange={(event) => updateCoordinate("lng", event.target.value)} /></label>
      </div>
      <div className="map-actions">
        <a className="secondary" href={openStreetMapUrl(activePin)} target="_blank" rel="noreferrer">Open map</a>
        <button className="secondary" type="button" onClick={() => onChange(undefined)}>Clear pin</button>
      </div>
    </section>
  );
}
