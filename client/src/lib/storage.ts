import type { EventState, Profile } from "./types";
import { randomAvatar, randomId } from "./id";
import { decryptJson, deriveRoomKey, encryptJson } from "./crypto";

const PROFILE_KEY = "party-p2p:profile";
const ADMIN_TOKEN_PREFIX = "party-p2p:admin-token:";
const BACKUP_PREFIX = "party-p2p:backup:";

export function loadProfile(): Profile {
  const existing = localStorage.getItem(PROFILE_KEY);
  if (existing) {
    try {
      return JSON.parse(existing) as Profile;
    } catch {
      localStorage.removeItem(PROFILE_KEY);
    }
  }

  const profile: Profile = {
    id: randomId("guest"),
    name: `Guest ${Math.floor(100 + Math.random() * 900)}`,
    avatar: randomAvatar()
  };
  saveProfile(profile);
  return profile;
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function loadAdminToken(roomName: string): string | undefined {
  return localStorage.getItem(`${ADMIN_TOKEN_PREFIX}${roomName}`) || undefined;
}

export function saveAdminToken(roomName: string, token: string): void {
  localStorage.setItem(`${ADMIN_TOKEN_PREFIX}${roomName}`, token);
}

export async function saveEncryptedBackup(roomName: string, roomSecret: string, state: EventState): Promise<void> {
  const key = await deriveRoomKey(roomSecret, roomName);
  const encrypted = await encryptJson(key, {
    savedAt: Date.now(),
    state
  });
  localStorage.setItem(`${BACKUP_PREFIX}${roomName}`, JSON.stringify(encrypted));
}

export async function loadEncryptedBackup(roomName: string, roomSecret: string): Promise<EventState | undefined> {
  const raw = localStorage.getItem(`${BACKUP_PREFIX}${roomName}`);
  if (!raw) return undefined;
  try {
    const key = await deriveRoomKey(roomSecret, roomName);
    const payload = JSON.parse(raw) as { iv: string; data: string };
    const decoded = await decryptJson<{ savedAt: number; state: EventState }>(key, payload);
    return decoded.state;
  } catch {
    return undefined;
  }
}

export function downloadBackup(roomName: string): void {
  const raw = localStorage.getItem(`${BACKUP_PREFIX}${roomName}`);
  if (!raw) return;
  const blob = new Blob([raw], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${roomName}-encrypted-party-backup.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
