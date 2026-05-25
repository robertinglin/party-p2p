const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalJson,
  createChatMessageEvent,
  createSignedPartyEvent,
  decryptPartyPayload,
  generatePartyIdentity,
  nostrEventToPartyEvent,
  PARTY_NOSTR_KIND,
  partyEventToNostrEvent,
  validatePartyEvent
} = require("../host/partyEvent.cjs");

test("canonicalJson sorts keys and normalizes strings", () => {
  assert.equal(canonicalJson({ b: 2, a: "e\u0301", skip: undefined }), '{"a":"é","b":2}');
});

test("creates encrypted signed chat events that validate and decrypt with the room secret", () => {
  const identity = generatePartyIdentity(1000);
  const event = createChatMessageEvent({
    partyId: "summer-pool-party-7kq9",
    identity,
    roomSecret: "invite-secret",
    text: "That was awesome.",
    displayName: "Rob",
    createdAt: 1760000000000
  });

  const validation = validatePartyEvent(event, { now: 1760000000000 });
  assert.equal(validation.ok, true);
  assert.equal(event.payload.encrypted, true);
  assert.equal(JSON.stringify(event.payload).includes("That was awesome."), false);

  const payload = decryptPartyPayload({
    roomSecret: "invite-secret",
    partyId: event.partyId,
    kind: event.kind,
    payload: event.payload
  });
  assert.deepEqual(payload, {
    displayName: "Rob",
    text: "That was awesome."
  });
});

test("rejects plaintext chat messages by default", () => {
  const identity = generatePartyIdentity(1000);
  const event = createSignedPartyEvent({
    kind: "chat.message",
    partyId: "local-demo-room",
    identity,
    payload: { text: "visible text" },
    createdAt: 1760000000000
  });

  const validation = validatePartyEvent(event, { now: 1760000000000 });
  assert.equal(validation.ok, false);
  assert.equal(validation.code, "UNENCRYPTED_PAYLOAD");
});

test("rejects tampered signed events", () => {
  const identity = generatePartyIdentity(1000);
  const event = createChatMessageEvent({
    partyId: "local-demo-room",
    identity,
    roomSecret: "invite-secret",
    text: "hello",
    createdAt: 1760000000000
  });

  const tampered = { ...event, partyId: "other-room" };
  const validation = validatePartyEvent(tampered, { now: 1760000000000 });
  assert.equal(validation.ok, false);
  assert.equal(validation.code, "INVALID_EVENT");
});

test("maps party events to signed Nostr events without exposing raw chat text", () => {
  const identity = generatePartyIdentity(1000);
  const event = createChatMessageEvent({
    partyId: "local-demo-room",
    identity,
    roomSecret: "invite-secret",
    text: "private message",
    createdAt: 1760000000000
  });

  const nostrEvent = partyEventToNostrEvent(event);
  assert.equal(nostrEvent.id, event.id);
  assert.equal(nostrEvent.pubkey, event.pubkey);
  assert.equal(nostrEvent.kind, PARTY_NOSTR_KIND);
  assert.equal(nostrEvent.content.includes("private message"), false);
  assert.deepEqual(nostrEventToPartyEvent(nostrEvent), event);
});
