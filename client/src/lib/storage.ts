import type { EventDetails, EventState, Profile, RoomConfig, SavedInvite } from "./types";
import { randomAvatar, randomId } from "./id";
import { decryptJson, deriveRoomKey, encryptJson } from "./crypto";

const PROFILE_KEY = "party-p2p:profile";
const SAVED_INVITES_KEY = "party-p2p:saved-invites";
const ADMIN_TOKEN_PREFIX = "party-p2p:admin-token:";
const BACKUP_PREFIX = "party-p2p:backup:";
const memoryStorage = new Map<string, string>();

function readStorage(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    return value ?? memoryStorage.get(key) ?? null;
  } catch {
    return memoryStorage.get(key) ?? null;
  }
}

function writeStorage(key: string, value: string): void {
  memoryStorage.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Firefox private windows and hardened browser settings can reject storage.
  }
}

function removeStorage(key: string): void {
  memoryStorage.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Keep the in-memory fallback authoritative for this session.
  }
}

export function loadProfile(): Profile {
  const existing = readStorage(PROFILE_KEY);
  if (existing) {
    try {
      return JSON.parse(existing) as Profile;
    } catch {
      removeStorage(PROFILE_KEY);
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
  writeStorage(PROFILE_KEY, JSON.stringify(profile));
}

function inviteId(config: RoomConfig): string {
  return `${config.roomPeerId}:${config.roomName}:${config.roomSecret}`;
}

function readSavedInviteList(): SavedInvite[] {
  const raw = readStorage(SAVED_INVITES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SavedInvite[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    removeStorage(SAVED_INVITES_KEY);
    return [];
  }
}

function writeSavedInviteList(invites: SavedInvite[]): SavedInvite[] {
  const sorted = invites.slice().sort((a, b) => inviteSortTime(b) - inviteSortTime(a));
  writeStorage(SAVED_INVITES_KEY, JSON.stringify(sorted));
  return sorted;
}

export function loadSavedInvites(): SavedInvite[] {
  return readSavedInviteList();
}

function inviteSortTime(invite: SavedInvite): number {
  return invite.stateUpdatedAt || invite.lastJoinedAt || invite.lastOpenedAt || invite.acceptedAt || invite.openedAt || 0;
}

export function saveOpenedInvite(config: RoomConfig): SavedInvite[] {
  const now = Date.now();
  const invites = readSavedInviteList();
  const id = inviteId(config);
  const existing = invites.find((invite) => invite.id === id);
  const nextInvite: SavedInvite = {
    ...existing,
    id,
    config,
    openedAt: existing?.openedAt || existing?.acceptedAt || now,
    lastOpenedAt: now
  };
  return writeSavedInviteList([nextInvite, ...invites.filter((invite) => invite.id !== id)]);
}

export function saveAcceptedInvite(config: RoomConfig, profile: Profile): SavedInvite[] {
  const now = Date.now();
  const invites = readSavedInviteList();
  const id = inviteId(config);
  const existing = invites.find((invite) => invite.id === id);
  const nextInvite: SavedInvite = {
    ...existing,
    id,
    config,
    profile,
    openedAt: existing?.openedAt || now,
    lastOpenedAt: now,
    acceptedAt: existing?.acceptedAt || now,
    lastJoinedAt: now
  };
  return writeSavedInviteList([nextInvite, ...invites.filter((invite) => invite.id !== id)]);
}

export function saveInviteSnapshot(config: RoomConfig, profile: Profile, details: EventDetails, stateUpdatedAt: number): SavedInvite[] {
  const now = Date.now();
  const invites = readSavedInviteList();
  const id = inviteId(config);
  const existing = invites.find((invite) => invite.id === id);
  const nextInvite: SavedInvite = {
    ...existing,
    id,
    config,
    profile,
    details,
    stateUpdatedAt,
    openedAt: existing?.openedAt || now,
    lastOpenedAt: now,
    acceptedAt: existing?.acceptedAt || now,
    lastJoinedAt: now
  };
  return writeSavedInviteList([nextInvite, ...invites.filter((invite) => invite.id !== id)]);
}

export function removeSavedInvite(id: string): SavedInvite[] {
  return writeSavedInviteList(readSavedInviteList().filter((invite) => invite.id !== id));
}

export function loadAdminToken(roomName: string): string | undefined {
  return readStorage(`${ADMIN_TOKEN_PREFIX}${roomName}`) || undefined;
}

export function saveAdminToken(roomName: string, token: string): void {
  writeStorage(`${ADMIN_TOKEN_PREFIX}${roomName}`, token);
}

export async function saveEncryptedBackup(roomName: string, roomSecret: string, state: EventState): Promise<void> {
  const key = await deriveRoomKey(roomSecret, roomName);
  const encrypted = await encryptJson(key, {
    savedAt: Date.now(),
    state
  });
  writeStorage(`${BACKUP_PREFIX}${roomName}`, JSON.stringify(encrypted));
}

export async function loadEncryptedBackup(roomName: string, roomSecret: string): Promise<EventState | undefined> {
  const raw = readStorage(`${BACKUP_PREFIX}${roomName}`);
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
  const raw = readStorage(`${BACKUP_PREFIX}${roomName}`);
  if (!raw) return;
  const blob = new Blob([raw], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${roomName}-encrypted-party-backup.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
