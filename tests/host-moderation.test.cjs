const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { applyMutation, guestForProfile } = require("../host/host.cjs");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "party-p2p-host-"));
let mutationCount = 0;
let roomCount = 0;

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeStore() {
  const roomName = `moderation-${roomCount++}`;
  const store = {
    roomName,
    roomSecret: "secret",
    admins: {},
    seenMutations: [],
    state: {
      version: 0,
      updatedAt: 0,
      details: {
        id: `event_${roomName}`,
        roomName,
        title: "Moderation Test",
        date: "2026-06-20",
        time: "8:00 PM",
        location: "Test Venue",
        description: "",
        coverEmoji: "✨",
        dressCode: "",
        hostNote: "",
        theme: "sunset"
      },
      guests: {
        admin: {
          id: "admin",
          name: "Admin",
          avatar: "✨",
          rsvp: "yes",
          role: "admin",
          joinedAt: 1,
          lastSeenAt: 1
        },
        guest: {
          id: "guest",
          name: "Guest",
          avatar: "🎧",
          rsvp: "unset",
          role: "guest",
          joinedAt: 2,
          lastSeenAt: 2
        }
      },
      posts: [],
      comments: [],
      adminIds: ["admin"]
    }
  };

  Object.defineProperty(store, "dataDir", {
    value: tmpRoot,
    configurable: true
  });
  return store;
}

function mutation(clientId, op, payload) {
  mutationCount += 1;
  return {
    id: `mutation_${mutationCount}`,
    clientId,
    seq: mutationCount,
    ts: mutationCount,
    op,
    payload
  };
}

test("admin can lock guest names and disable guest posting", () => {
  const store = makeStore();

  const result = applyMutation(
    store,
    mutation("admin", "guest.moderate", { guestId: "guest", nameLocked: true, chatDisabled: true }),
    "admin"
  );

  assert.equal(result.changed, true);
  assert.equal(store.state.guests.guest.nameLocked, true);
  assert.equal(store.state.guests.guest.chatDisabled, true);
});

test("guests cannot moderate other guests", () => {
  const store = makeStore();

  const result = applyMutation(
    store,
    mutation("guest", "guest.moderate", { guestId: "admin", chatDisabled: true }),
    "guest"
  );

  assert.equal(result.changed, false);
  assert.equal(result.error, "Only admins can moderate guests.");
  assert.equal(store.state.guests.admin.chatDisabled, undefined);
});

test("locked guests cannot change identity but can still RSVP", () => {
  const store = makeStore();
  store.state.guests.guest.nameLocked = true;

  const identityResult = applyMutation(
    store,
    mutation("guest", "guest.update", { name: "A very different name", avatar: "🔥" }),
    "guest"
  );

  assert.equal(identityResult.changed, false);
  assert.equal(identityResult.error, "This guest's name is locked by the host.");
  assert.equal(store.state.guests.guest.name, "Guest");
  assert.equal(store.state.guests.guest.avatar, "🎧");

  const rsvpResult = applyMutation(store, mutation("guest", "guest.update", { rsvp: "yes" }), "guest");

  assert.equal(rsvpResult.changed, true);
  assert.equal(store.state.guests.guest.rsvp, "yes");
});

test("admin location pin updates are sanitized without dropping the mutation", () => {
  const store = makeStore();

  const result = applyMutation(
    store,
    mutation("admin", "event.update", {
      locationPin: {
        lat: "91",
        lng: "190",
        zoom: "22"
      }
    }),
    "admin"
  );

  assert.equal(result.changed, true);
  assert.deepEqual(store.state.details.locationPin, {
    lat: 85.05112878,
    lng: -170,
    zoom: 18
  });
});

test("invalid location pin clears the stored pin", () => {
  const store = makeStore();
  store.state.details.locationPin = { lat: 40, lng: -73, zoom: 12 };

  const result = applyMutation(store, mutation("admin", "event.update", { locationPin: { lat: "nope", lng: -73 } }), "admin");

  assert.equal(result.changed, true);
  assert.equal(store.state.details.locationPin, undefined);
});

test("locked guest identity survives reconnect profiles", () => {
  const store = makeStore();
  store.state.guests.guest.nameLocked = true;

  const guest = guestForProfile(
    store,
    { id: "guest", name: "Changed During Rejoin", avatar: "🔥" },
    "peer-id",
    "guest"
  );

  assert.equal(guest.name, "Guest");
  assert.equal(guest.avatar, "🎧");
  assert.equal(guest.nameLocked, true);
});

test("muted guests cannot add posts or comments", () => {
  const store = makeStore();
  store.state.guests.guest.chatDisabled = true;

  const postResult = applyMutation(store, mutation("guest", "post.add", { body: "Please publish this." }), "guest");
  const commentResult = applyMutation(store, mutation("guest", "comment.add", { body: "Also this." }), "guest");

  assert.equal(postResult.changed, false);
  assert.equal(postResult.error, "Posting is disabled for this guest.");
  assert.equal(commentResult.changed, false);
  assert.equal(commentResult.error, "Posting is disabled for this guest.");
  assert.deepEqual(store.state.posts, []);
  assert.deepEqual(store.state.comments, []);
});
