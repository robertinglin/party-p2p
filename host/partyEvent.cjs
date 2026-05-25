const crypto = require("node:crypto");
const {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  validateEvent: validateNostrEvent,
  verifyEvent: verifyNostrEvent
} = require("nostr-tools/pure");
const { bytesToHex, hexToBytes } = require("nostr-tools/utils");

const PROTOCOL = "party-p2p";
const VERSION = 1;
const PARTY_NOSTR_KIND = 9321;
const ENCRYPTION_ALG = "A256GCM";
const PARTY_EVENT_KINDS = new Set(["party.created", "chat.message", "chat.delete", "relay.announce"]);
const PARTY_ID_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;
const HEX_32_PATTERN = /^[0-9a-f]{64}$/i;
const HEX_64_PATTERN = /^[0-9a-f]{128}$/i;
const DEFAULT_MAX_EVENT_BYTES = 8 * 1024;
const DEFAULT_MAX_MESSAGE_CHARS = 2000;
const DEFAULT_MAX_FUTURE_MS = 10 * 60 * 1000;

function canonicalJson(value) {
  return canonicalJsonInner(value, new WeakSet());
}

function canonicalJsonInner(value, seen) {
  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid number");
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonInner(item, seen)).join(",")}]`;
  }

  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Cannot canonicalize cyclic values");
    seen.add(value);
    const obj = value;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const result = `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonInner(obj[key], seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return result;
  }

  throw new Error("Unsupported value");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value) {
  return Buffer.from(String(value), "base64url");
}

function deriveRoomKeyBytes(roomSecret, partyId) {
  return crypto.pbkdf2Sync(
    String(roomSecret),
    `party-p2p:${partyId}`,
    120000,
    32,
    "sha256"
  );
}

function encryptionAad(partyId, kind) {
  return Buffer.from(`${PROTOCOL}:v${VERSION}:${partyId}:${kind}`, "utf8");
}

function encryptPartyPayload({ roomSecret, partyId, kind, payload }) {
  if (!roomSecret) throw new Error("roomSecret is required to encrypt party payloads");
  if (!isValidPartyId(partyId)) throw new Error("Invalid partyId");
  if (!PARTY_EVENT_KINDS.has(kind)) throw new Error("Invalid party event kind");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveRoomKeyBytes(roomSecret, partyId), iv);
  cipher.setAAD(encryptionAad(partyId, kind));
  const plaintext = Buffer.from(canonicalJson(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  return {
    encrypted: true,
    alg: ENCRYPTION_ALG,
    iv: base64url(iv),
    data: base64url(ciphertext)
  };
}

function decryptPartyPayload({ roomSecret, partyId, kind, payload }) {
  if (!isEncryptedPayload(payload)) throw new Error("Payload is not encrypted");

  const bytes = fromBase64url(payload.data);
  if (bytes.length < 17) throw new Error("Invalid encrypted payload");

  const ciphertext = bytes.subarray(0, bytes.length - 16);
  const authTag = bytes.subarray(bytes.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveRoomKeyBytes(roomSecret, partyId), fromBase64url(payload.iv));
  decipher.setAAD(encryptionAad(partyId, kind));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function generatePartyIdentity(createdAt = Date.now()) {
  const privateKeyBytes = generateSecretKey();
  const privateKey = bytesToHex(privateKeyBytes);
  return {
    pubkey: getPublicKey(privateKeyBytes),
    privateKey,
    createdAt
  };
}

function unsignedFields(event) {
  return {
    protocol: event.protocol,
    version: event.version,
    kind: event.kind,
    partyId: event.partyId,
    pubkey: event.pubkey,
    createdAt: event.createdAt,
    payload: event.payload
  };
}

function partyNostrTags(unsigned) {
  return [
    ["protocol", PROTOCOL],
    ["version", String(VERSION)],
    ["d", unsigned.partyId],
    ["k", unsigned.kind],
    ["created-at-ms", String(unsigned.createdAt)]
  ];
}

function tagValue(tags, name) {
  const tag = tags.find((item) => Array.isArray(item) && item[0] === name);
  return tag ? tag[1] : undefined;
}

function partyEventToNostrTemplate(unsigned) {
  return {
    kind: PARTY_NOSTR_KIND,
    created_at: Math.floor(unsigned.createdAt / 1000),
    tags: partyNostrTags(unsigned),
    content: canonicalJson({ payload: unsigned.payload })
  };
}

function partyEventToNostrEvent(event) {
  return {
    ...partyEventToNostrTemplate(unsignedFields(event)),
    id: event.id,
    pubkey: event.pubkey,
    sig: event.sig
  };
}

function nostrEventToPartyEvent(nostrEvent) {
  const tags = Array.isArray(nostrEvent?.tags) ? nostrEvent.tags : [];
  const content = JSON.parse(nostrEvent.content || "{}");
  return {
    protocol: tagValue(tags, "protocol"),
    version: Number(tagValue(tags, "version")),
    id: nostrEvent.id,
    kind: tagValue(tags, "k"),
    partyId: tagValue(tags, "d"),
    pubkey: nostrEvent.pubkey,
    createdAt: Number(tagValue(tags, "created-at-ms")),
    payload: content.payload,
    sig: nostrEvent.sig
  };
}

function eventIdForUnsigned(unsigned) {
  return getEventHash({
    ...partyEventToNostrTemplate(unsigned),
    pubkey: unsigned.pubkey
  });
}

function createSignedPartyEvent({ kind, partyId, identity, payload, roomSecret, createdAt = Date.now() }) {
  const signedPayload = roomSecret
    ? encryptPartyPayload({ roomSecret, partyId, kind, payload })
    : payload;
  const unsigned = {
    protocol: PROTOCOL,
    version: VERSION,
    kind,
    partyId,
    pubkey: identity.pubkey,
    createdAt,
    payload: signedPayload
  };
  const nostrEvent = finalizeEvent(partyEventToNostrTemplate(unsigned), hexToBytes(identity.privateKey));
  return nostrEventToPartyEvent(nostrEvent);
}

function createChatMessageEvent(input) {
  const payload = {
    text: String(input.text || "")
  };
  if (input.displayName !== undefined) payload.displayName = String(input.displayName);
  if (input.replyTo !== undefined) payload.replyTo = String(input.replyTo);

  const validation = validateChatMessagePayload(payload, DEFAULT_MAX_MESSAGE_CHARS);
  if (!validation.ok) throw new Error(validation.message);

  return createSignedPartyEvent({
    kind: "chat.message",
    partyId: input.partyId,
    identity: input.identity,
    payload,
    roomSecret: input.roomSecret,
    createdAt: input.createdAt
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEncryptedPayload(value) {
  return (
    isPlainObject(value) &&
    value.encrypted === true &&
    value.alg === ENCRYPTION_ALG &&
    typeof value.iv === "string" &&
    typeof value.data === "string"
  );
}

function isValidPartyId(value) {
  return typeof value === "string" && PARTY_ID_PATTERN.test(value);
}

function ok() {
  return { ok: true };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function validateString(value, max, name) {
  if (typeof value !== "string") return fail("INVALID_PAYLOAD", `${name} must be a string`);
  if (value.length > max) return fail("INVALID_PAYLOAD", `${name} is too long`);
  return ok();
}

function validateChatMessagePayload(payload, maxMessageChars) {
  if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "chat.message payload must be an object");
  if (typeof payload.text !== "string") return fail("INVALID_PAYLOAD", "text is required");
  const text = payload.text.trim();
  if (text.length < 1) return fail("INVALID_PAYLOAD", "text is required");
  if (payload.text.length > maxMessageChars) return fail("INVALID_PAYLOAD", "text is too long");
  if (payload.displayName !== undefined) {
    const result = validateString(payload.displayName, 80, "displayName");
    if (!result.ok) return result;
  }
  if (payload.replyTo !== undefined) {
    const result = validateString(payload.replyTo, 128, "replyTo");
    if (!result.ok) return result;
  }
  return ok();
}

function validatePartyCreatedPayload(payload) {
  if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "party.created payload must be an object");
  if (payload.title !== undefined) {
    const result = validateString(payload.title, 200, "title");
    if (!result.ok) return result;
  }
  if (payload.createdByDisplayName !== undefined) {
    const result = validateString(payload.createdByDisplayName, 80, "createdByDisplayName");
    if (!result.ok) return result;
  }
  return ok();
}

function validateChatDeletePayload(payload) {
  if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "chat.delete payload must be an object");
  const idResult = validateString(payload.targetEventId, 128, "targetEventId");
  if (!idResult.ok) return idResult;
  if (payload.reason !== undefined && !["user", "moderation"].includes(payload.reason)) {
    return fail("INVALID_PAYLOAD", "reason must be user or moderation");
  }
  return ok();
}

function validateRelayAnnouncePayload(payload) {
  if (!isPlainObject(payload)) return fail("INVALID_PAYLOAD", "relay.announce payload must be an object");
  const urlResult = validateString(payload.relayUrl, 500, "relayUrl");
  if (!urlResult.ok) return urlResult;
  if (!/^wss?:\/\//.test(payload.relayUrl)) return fail("INVALID_PAYLOAD", "relayUrl must use ws:// or wss://");
  const relayIdResult = validateString(payload.relayId, 200, "relayId");
  if (!relayIdResult.ok) return relayIdResult;
  return ok();
}

function validatePlainPayload(kind, payload, maxMessageChars) {
  switch (kind) {
    case "party.created":
      return validatePartyCreatedPayload(payload);
    case "chat.message":
      return validateChatMessagePayload(payload, maxMessageChars);
    case "chat.delete":
      return validateChatDeletePayload(payload);
    case "relay.announce":
      return validateRelayAnnouncePayload(payload);
    default:
      return fail("INVALID_KIND", "Unknown party event kind");
  }
}

function validatePartyEvent(event, options = {}) {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const maxFutureMs = options.maxFutureMs ?? DEFAULT_MAX_FUTURE_MS;
  const requireEncryptedChat = options.requireEncryptedChat ?? true;
  const now = options.now ?? Date.now();

  if (!isPlainObject(event)) return fail("INVALID_EVENT", "Event must be an object");

  let eventJson;
  try {
    eventJson = JSON.stringify(event);
  } catch {
    return fail("INVALID_EVENT", "Event must be JSON serializable");
  }
  if (Buffer.byteLength(eventJson, "utf8") > maxEventBytes) {
    return fail("EVENT_TOO_LARGE", "Event JSON is too large");
  }

  if (event.protocol !== PROTOCOL) return fail("INVALID_EVENT", "Missing protocol=party-p2p");
  if (event.version !== VERSION) return fail("INVALID_EVENT", "Unsupported party event version");
  if (!PARTY_EVENT_KINDS.has(event.kind)) return fail("INVALID_KIND", "Unknown party event kind");
  if (!isValidPartyId(event.partyId)) return fail("INVALID_PARTY_ID", "Invalid partyId");
  if (typeof event.pubkey !== "string" || !HEX_32_PATTERN.test(event.pubkey)) return fail("INVALID_EVENT", "Invalid pubkey");
  if (!Number.isInteger(event.createdAt)) return fail("INVALID_EVENT", "createdAt must be an integer");
  if (event.createdAt > now + maxFutureMs) return fail("INVALID_EVENT", "createdAt is too far in the future");
  if (typeof event.id !== "string" || !HEX_32_PATTERN.test(event.id)) return fail("INVALID_EVENT", "Invalid event id");
  if (typeof event.sig !== "string" || !HEX_64_PATTERN.test(event.sig)) return fail("INVALID_EVENT", "Invalid signature");

  if (isEncryptedPayload(event.payload)) {
    if (fromBase64url(event.payload.iv).length !== 12) return fail("INVALID_PAYLOAD", "Invalid encrypted payload iv");
    if (fromBase64url(event.payload.data).length > maxEventBytes) return fail("INVALID_PAYLOAD", "Encrypted payload is too large");
  } else {
    if (event.kind === "chat.message" && requireEncryptedChat) {
      return fail("UNENCRYPTED_PAYLOAD", "chat.message payloads must be encrypted with the party secret");
    }
    const payloadResult = validatePlainPayload(event.kind, event.payload, maxMessageChars);
    if (!payloadResult.ok) return payloadResult;
  }

  let expectedId;
  try {
    expectedId = eventIdForUnsigned(unsignedFields(event));
  } catch {
    return fail("INVALID_EVENT", "Event body is not canonicalizable");
  }
  if (expectedId !== event.id) return fail("INVALID_EVENT", "Event id does not match event body");

  const nostrEvent = partyEventToNostrEvent(event);
  if (!validateNostrEvent(nostrEvent)) return fail("INVALID_EVENT", "Invalid Nostr event envelope");
  if (!verifyNostrEvent(nostrEvent)) return fail("INVALID_SIGNATURE", "Event signature did not verify");

  return ok();
}

module.exports = {
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_FUTURE_MS,
  DEFAULT_MAX_MESSAGE_CHARS,
  ENCRYPTION_ALG,
  PARTY_EVENT_KINDS,
  PARTY_ID_PATTERN,
  PARTY_NOSTR_KIND,
  PROTOCOL,
  VERSION,
  canonicalJson,
  createChatMessageEvent,
  createSignedPartyEvent,
  decryptPartyPayload,
  encryptPartyPayload,
  eventIdForUnsigned,
  generatePartyIdentity,
  isEncryptedPayload,
  isValidPartyId,
  nostrEventToPartyEvent,
  partyEventToNostrEvent,
  partyEventToNostrTemplate,
  sha256Hex,
  unsignedFields,
  validatePartyEvent
};
