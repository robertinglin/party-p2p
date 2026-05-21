import type { LocationPin } from "./types";

const TILE_SIZE = 256;
const MAX_LAT = 85.05112878;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;

export const DEFAULT_LOCATION_PIN: LocationPin = {
  lat: 40.6782,
  lng: -73.9442,
  zoom: 13
};

export type MapTile = {
  key: string;
  url: string;
  left: number;
  top: number;
};

type WorldPoint = {
  x: number;
  y: number;
};

export function clampLatitude(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
}

export function normalizeLocationPin(pin: LocationPin | undefined): LocationPin {
  if (!pin) return DEFAULT_LOCATION_PIN;
  return {
    lat: clampLatitude(pin.lat),
    lng: wrapLongitude(pin.lng),
    zoom: clampZoom(pin.zoom)
  };
}

export function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

export function openStreetMapUrl(pin: LocationPin): string {
  const normalized = normalizeLocationPin(pin);
  const lat = formatCoordinate(normalized.lat);
  const lng = formatCoordinate(normalized.lng);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${normalized.zoom}/${lat}/${lng}`;
}

export function latLngToWorld(pin: LocationPin): WorldPoint {
  const zoom = clampZoom(pin.zoom);
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = clampLatitude(pin.lat) * Math.PI / 180;
  return {
    x: (wrapLongitude(pin.lng) + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + Math.sin(lat)) / (1 - Math.sin(lat))) / (4 * Math.PI)) * scale
  };
}

export function worldToLatLng(point: WorldPoint, zoom: number): LocationPin {
  const scale = TILE_SIZE * 2 ** clampZoom(zoom);
  const lng = point.x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * point.y / scale;
  const lat = Math.atan(Math.sinh(n)) * 180 / Math.PI;
  return {
    lat: clampLatitude(lat),
    lng: wrapLongitude(lng),
    zoom: clampZoom(zoom)
  };
}

export function mapTiles(center: LocationPin, width: number, height: number): MapTile[] {
  const pin = normalizeLocationPin(center);
  const centerWorld = latLngToWorld(pin);
  const startX = Math.floor((centerWorld.x - width / 2) / TILE_SIZE);
  const endX = Math.floor((centerWorld.x + width / 2) / TILE_SIZE);
  const startY = Math.floor((centerWorld.y - height / 2) / TILE_SIZE);
  const endY = Math.floor((centerWorld.y + height / 2) / TILE_SIZE);
  const tileCount = 2 ** pin.zoom;
  const tiles: MapTile[] = [];

  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      if (y < 0 || y >= tileCount) continue;
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${pin.zoom}-${wrappedX}-${y}-${x}`,
        url: `https://tile.openstreetmap.org/${pin.zoom}/${wrappedX}/${y}.png`,
        left: x * TILE_SIZE - centerWorld.x + width / 2,
        top: y * TILE_SIZE - centerWorld.y + height / 2
      });
    }
  }

  return tiles;
}
