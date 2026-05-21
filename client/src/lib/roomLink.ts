import type { RoomConfig } from "./types";
import { roomToPeerId } from "./id";

export function parseRoomConfig(): RoomConfig | undefined {
  const hash = window.location.hash || "";
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return undefined;
  const route = hash.slice(0, queryIndex);
  if (!route.startsWith("#/room/")) return undefined;

  const roomName = decodeURIComponent(route.replace("#/room/", ""));
  const params = new URLSearchParams(hash.slice(queryIndex + 1));

  return {
    roomName,
    roomSecret: params.get("secret") || "",
    roomPeerId: params.get("roomPeerId") || roomToPeerId(roomName)
  };
}

export function buildRoomUrl(config: RoomConfig, base = window.location.origin + window.location.pathname): string {
  const params = new URLSearchParams();
  params.set("roomPeerId", config.roomPeerId);
  params.set("secret", config.roomSecret);
  return `${base.replace(/#.*$/, "")}#/room/${encodeURIComponent(config.roomName)}?${params.toString()}`;
}
