const AVATARS = ["🪩", "🌈", "💅", "✨", "🍓", "🍕", "🦄", "🎧", "🧃", "🌙", "🔥", "🎈"];

export function randomId(prefix = "id"): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${token}`;
}

export function randomAvatar(): string {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}

export function slugifyRoom(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "party";
}

export function roomToPeerId(roomName: string): string {
  return `party-p2p-${slugifyRoom(roomName)}`;
}
