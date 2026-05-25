import type { RoomConfig } from "./types";
import { roomToPeerId } from "./id";

export function parseRoomConfigFromHash(hash: string): RoomConfig | undefined {
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return undefined;
  const route = hash.slice(0, queryIndex);
  if (!route.startsWith("#/room/")) return undefined;

  const roomName = decodeURIComponent(route.replace("#/room/", ""));
  const params = new URLSearchParams(hash.slice(queryIndex + 1));

  const config: RoomConfig = {
    roomName,
    roomSecret: params.get("secret") || "",
    roomPeerId: params.get("roomPeerId") || roomToPeerId(roomName)
  };
  const relayAddress = params.get("relayAddress");
  if (relayAddress) config.relayAddress = relayAddress;
  return config;
}

export function parseRoomConfigFromUrl(
  value: string,
  base = typeof window === "undefined" ? "https://party-p2p.invalid/" : window.location.href
): RoomConfig | undefined {
  try {
    const url = new URL(value, base);
    return parseRoomConfigFromHash(url.hash);
  } catch {
    return value.startsWith("#/room/") ? parseRoomConfigFromHash(value) : undefined;
  }
}

export function parseRoomConfig(): RoomConfig | undefined {
  return parseRoomConfigFromHash(window.location.hash || "");
}

export function buildRoomUrl(config: RoomConfig, base = window.location.origin + window.location.pathname): string {
  const params = new URLSearchParams();
  params.set("roomPeerId", config.roomPeerId);
  if (config.relayAddress) params.set("relayAddress", config.relayAddress);
  params.set("secret", config.roomSecret);
  return `${base.replace(/#.*$/, "")}#/room/${encodeURIComponent(config.roomName)}?${params.toString()}`;
}
