import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { P2PRoomClient } from "./lib/peerRoom";
import type { Comment, EventDetails, EventState, Guest, Post, Profile, Role, RoomConfig, Rsvp } from "./lib/types";
import { randomAvatar, roomToPeerId, slugifyRoom } from "./lib/id";
import { buildRoomUrl, parseRoomConfig } from "./lib/roomLink";
import { downloadBackup, loadEncryptedBackup, loadProfile, saveProfile } from "./lib/storage";
import { LocationMap, MapPinEditor } from "./components/OpenStreetMap";
import { openStreetMapUrl } from "./lib/map";

type Status = "idle" | "connecting" | "connected" | "offline" | "error";

function formatDate(details: EventDetails): string {
  const bits = [details.date, details.time].filter(Boolean);
  return bits.length ? bits.join(" • ") : "Date TBA";
}

function guestCounts(guests: Record<string, Guest>) {
  return Object.values(guests).reduce(
    (acc, guest) => {
      acc[guest.rsvp] += 1;
      return acc;
    },
    { yes: 0, maybe: 0, no: 0, unset: 0 } as Record<Rsvp, number>
  );
}

function isAdmin(role: Role): boolean {
  return role === "admin";
}

function emptyConfigFromForm(): RoomConfig {
  const roomName = "rooftop-disco";
  return {
    roomName,
    roomSecret: "paste-room-secret-from-host",
    roomPeerId: roomToPeerId(roomName)
  };
}

export default function App() {
  const [config, setConfig] = useState<RoomConfig | undefined>(() => parseRoomConfig());
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [state, setState] = useState<EventState | undefined>();
  const [role, setRole] = useState<Role>("guest");
  const [status, setStatus] = useState<Status>(config ? "connecting" : "idle");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const clientRef = useRef<P2PRoomClient | undefined>(undefined);

  useEffect(() => {
    function syncRoomConfigFromHash() {
      setConfig(parseRoomConfig());
    }

    window.addEventListener("hashchange", syncRoomConfigFromHash);
    return () => window.removeEventListener("hashchange", syncRoomConfigFromHash);
  }, []);

  useEffect(() => {
    if (!config) {
      clientRef.current = undefined;
      setState(undefined);
      setRole("guest");
      setStatus("idle");
      setStatusDetail("");
      return;
    }

    let cancelled = false;
    setState(undefined);
    setRole("guest");
    setStatus("connecting");
    setStatusDetail("");
    setToast("");

    const client = new P2PRoomClient(config, profile, {
      onStatus: (next, detail) => {
        if (cancelled) return;
        setStatus(next);
        setStatusDetail(detail || "");
      },
      onState: (nextState) => {
        if (cancelled) return;
        setState(nextState);
      },
      onRole: (nextRole) => {
        if (cancelled) return;
        setRole(nextRole);
      },
      onError: (message) => {
        if (cancelled) return;
        setToast(message);
      }
    });

    clientRef.current = client;
    void loadEncryptedBackup(config.roomName, config.roomSecret).then((backup) => {
      if (!cancelled && backup) setState(backup);
    });
    void client.start();

    return () => {
      cancelled = true;
      client.destroy();
      if (clientRef.current === client) clientRef.current = undefined;
    };
  }, [config?.roomName, config?.roomPeerId, config?.roomSecret, profile.id]);

  function send(op: Parameters<P2PRoomClient["sendMutation"]>[0], payload: Record<string, unknown>) {
    clientRef.current?.sendMutation(op, payload);
  }

  function updateProfile(nextProfile: Profile) {
    setProfile(nextProfile);
    saveProfile(nextProfile);
    send("guest.update", { name: nextProfile.name, avatar: nextProfile.avatar });
  }

  if (!config) {
    return <JoinScreen onJoin={setConfig} profile={profile} onProfile={updateProfile} />;
  }

  return (
    <main className={`app theme-${state?.details.theme || "sunset"}`}>
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <header className="topbar glass">
        <div>
          <span className="brand-kicker">Party P2P</span>
          <h1>{state?.details.title || config.roomName}</h1>
        </div>
        <ConnectionPill status={status} detail={statusDetail} role={role} />
      </header>

      {toast ? (
        <button className="toast" onClick={() => setToast("")}>{toast}</button>
      ) : null}

      {state ? (
        <EventView
          state={state}
          role={role}
          profile={profile}
          config={config}
          onProfile={updateProfile}
          onMutation={send}
          onDownloadBackup={() => downloadBackup(config.roomName)}
        />
      ) : (
        <section className="loading-card glass">
          <div className="spinner" />
          <h2>Opening the room…</h2>
          <p>Connecting to the host peer at <strong>{config.roomPeerId}</strong>.</p>
        </section>
      )}
    </main>
  );
}

function JoinScreen({ onJoin, profile, onProfile }: { onJoin: (config: RoomConfig) => void; profile: Profile; onProfile: (profile: Profile) => void }) {
  const [form, setForm] = useState<RoomConfig>(() => emptyConfigFromForm());

  function update<K extends keyof RoomConfig>(key: K, value: RoomConfig[K]) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "roomName") next.roomPeerId = roomToPeerId(String(value));
      return next;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onJoin({ ...form, roomName: slugifyRoom(form.roomName), roomPeerId: form.roomPeerId || roomToPeerId(form.roomName) });
  }

  return (
    <main className="app theme-sunset">
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <section className="join-shell glass">
        <p className="brand-kicker">Decentralized-ish invites</p>
        <h1>Peer-to-peer party pages.</h1>
        <p className="lede">Join a host-run room. Event data travels through WebRTC data channels and the app keeps an encrypted offline backup on your device.</p>

        <ProfileEditor profile={profile} onProfile={onProfile} compact />

        <form onSubmit={submit} className="join-form">
          <label>
            Room name
            <input value={form.roomName} onChange={(event) => update("roomName", event.target.value)} />
          </label>
          <label>
            Room secret
            <input value={form.roomSecret} onChange={(event) => update("roomSecret", event.target.value)} />
          </label>
          <button className="primary" type="submit">Join room</button>
        </form>
      </section>
    </main>
  );
}

function ConnectionPill({ status, detail, role }: { status: Status; detail: string; role: Role }) {
  return (
    <div className={`connection-pill ${status}`} title={detail}>
      <span className="dot" />
      <span>{status === "connected" ? "Live P2P" : status}</span>
      <strong>{role}</strong>
    </div>
  );
}

function EventView({
  state,
  role,
  profile,
  config,
  onProfile,
  onMutation,
  onDownloadBackup
}: {
  state: EventState;
  role: Role;
  profile: Profile;
  config: RoomConfig;
  onProfile: (profile: Profile) => void;
  onMutation: (op: Parameters<P2PRoomClient["sendMutation"]>[0], payload: Record<string, unknown>) => void;
  onDownloadBackup: () => void;
}) {
  const counts = guestCounts(state.guests);
  const currentGuest = state.guests[profile.id];

  return (
    <div className="event-layout">
      <section className="hero-card glass">
        <div className="hero-emoji" aria-hidden="true">{state.details.coverEmoji}</div>
        <p className="brand-kicker">You’re invited</p>
        <h2>{state.details.title}</h2>
        <p className="event-time">{formatDate(state.details)}</p>
        <p className="event-place">📍 {state.details.location || "Location TBA"}</p>
        <p className="description">{state.details.description}</p>
        <div className="rsvp-row">
          <button className={currentGuest?.rsvp === "yes" ? "selected" : ""} onClick={() => onMutation("guest.update", { rsvp: "yes" })}>Going</button>
          <button className={currentGuest?.rsvp === "maybe" ? "selected" : ""} onClick={() => onMutation("guest.update", { rsvp: "maybe" })}>Maybe</button>
          <button className={currentGuest?.rsvp === "no" ? "selected" : ""} onClick={() => onMutation("guest.update", { rsvp: "no" })}>Can’t go</button>
        </div>
        <div className="stats-row">
          <span><strong>{counts.yes}</strong> going</span>
          <span><strong>{counts.maybe}</strong> maybe</span>
          <span><strong>{Object.keys(state.guests).length}</strong> guests</span>
        </div>
      </section>

      <aside className="side-stack">
        <ShareCard config={config} />
        <ProfileEditor profile={profile} onProfile={onProfile} />
        <BackupCard version={state.version} updatedAt={state.updatedAt} onDownloadBackup={onDownloadBackup} />
      </aside>

      <section className="content-stack">
        {isAdmin(role) ? <AdminPanel details={state.details} onUpdate={(details) => onMutation("event.update", details as unknown as Record<string, unknown>)} /> : null}
        <PostsPanel state={state} profile={profile} role={role} onMutation={onMutation} />
      </section>

      <aside className="side-stack guests-stack">
        <GuestList guests={state.guests} adminIds={state.adminIds} />
        <DetailsCard details={state.details} />
      </aside>
    </div>
  );
}

function ShareCard({ config }: { config: RoomConfig }) {
  const [qr, setQr] = useState<string>("");
  const shareUrl = useMemo(() => buildRoomUrl(config), [config]);

  useEffect(() => {
    void QRCode.toDataURL(shareUrl, { margin: 1, width: 420 }).then(setQr);
  }, [shareUrl]);

  async function copy() {
    await navigator.clipboard?.writeText(shareUrl);
  }

  return (
    <section className="mini-card glass share-card">
      <div className="section-heading">
        <h3>Secure room QR</h3>
        <span>share link</span>
      </div>
      {qr ? <img className="qr" src={qr} alt="QR code for this room" /> : <div className="qr skeleton" />}
      <button className="secondary" onClick={copy}>Copy invite link</button>
      <p className="tiny">The room secret is in the URL hash, so it is not sent to the static web server.</p>
    </section>
  );
}

function ProfileEditor({ profile, onProfile, compact = false }: { profile: Profile; onProfile: (profile: Profile) => void; compact?: boolean }) {
  const [name, setName] = useState(profile.name);
  const [avatar, setAvatar] = useState(profile.avatar);

  function save() {
    onProfile({ ...profile, name: name.trim() || profile.name, avatar: avatar.trim() || randomAvatar() });
  }

  return (
    <section className={compact ? "profile-card compact" : "mini-card glass profile-card"}>
      <div className="section-heading">
        <h3>Your vibe</h3>
        {!compact ? <span>{profile.avatar}</span> : null}
      </div>
      <div className="profile-fields">
        <input className="avatar-input" value={avatar} onChange={(event) => setAvatar(event.target.value)} maxLength={3} aria-label="Avatar emoji" />
        <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Display name" />
        <button className="secondary" onClick={save}>Save</button>
      </div>
    </section>
  );
}

function BackupCard({ version, updatedAt, onDownloadBackup }: { version: number; updatedAt: number; onDownloadBackup: () => void }) {
  return (
    <section className="mini-card glass">
      <div className="section-heading">
        <h3>Offline backup</h3>
        <span>v{version}</span>
      </div>
      <p className="tiny">Last saved {new Date(updatedAt).toLocaleString()} in encrypted browser storage.</p>
      <button className="secondary" onClick={onDownloadBackup}>Download encrypted backup</button>
    </section>
  );
}

function DetailsCard({ details }: { details: EventDetails }) {
  return (
    <section className="mini-card glass details-card">
      <h3>Details</h3>
      <p><strong>When</strong><br />{formatDate(details)}</p>
      <p><strong>Where</strong><br />{details.location || "TBA"}</p>
      {details.locationPin ? (
        <>
          <LocationMap pin={details.locationPin} />
          <a className="secondary details-map-link" href={openStreetMapUrl(details.locationPin)} target="_blank" rel="noreferrer">Open map</a>
        </>
      ) : null}
      {details.dressCode ? <p><strong>Dress</strong><br />{details.dressCode}</p> : null}
      {details.hostNote ? <p><strong>Host note</strong><br />{details.hostNote}</p> : null}
    </section>
  );
}

function GuestList({ guests, adminIds }: { guests: Record<string, Guest>; adminIds: string[] }) {
  const sorted = Object.values(guests).sort((a, b) => {
    const order: Record<Rsvp, number> = { yes: 0, maybe: 1, unset: 2, no: 3 };
    return order[a.rsvp] - order[b.rsvp] || b.lastSeenAt - a.lastSeenAt;
  });

  return (
    <section className="mini-card glass">
      <div className="section-heading">
        <h3>Guest list</h3>
        <span>{sorted.length}</span>
      </div>
      <div className="guest-list">
        {sorted.map((guest) => (
          <div className="guest" key={guest.id}>
            <span className="avatar">{guest.avatar}</span>
            <div>
              <strong>{guest.name}</strong>
              <small>{adminIds.includes(guest.id) ? "admin" : guest.rsvp}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminPanel({ details, onUpdate }: { details: EventDetails; onUpdate: (details: Partial<EventDetails>) => void }) {
  const [draft, setDraft] = useState(details);

  useEffect(() => setDraft(details), [details]);

  function update<K extends keyof EventDetails>(key: K, value: EventDetails[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="admin-panel glass">
      <div className="section-heading">
        <h3>Admin controls</h3>
        <span>first joiner</span>
      </div>
      <div className="admin-grid">
        <label>Title<input value={draft.title} onChange={(event) => update("title", event.target.value)} /></label>
        <label>Emoji<input value={draft.coverEmoji} onChange={(event) => update("coverEmoji", event.target.value)} /></label>
        <label>Date<input value={draft.date} onChange={(event) => update("date", event.target.value)} /></label>
        <label>Time<input value={draft.time} onChange={(event) => update("time", event.target.value)} /></label>
        <label className="wide">Location<input value={draft.location} onChange={(event) => update("location", event.target.value)} /></label>
        <label className="wide">Description<textarea value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
        <div className="wide">
          <MapPinEditor
            details={draft}
            onChange={(locationPin) => update("locationPin", locationPin)}
            onVenueChange={(location) => update("location", location)}
          />
        </div>
        <label>Dress code<input value={draft.dressCode} onChange={(event) => update("dressCode", event.target.value)} /></label>
        <label>Theme
          <select value={draft.theme} onChange={(event) => update("theme", event.target.value as EventDetails["theme"])}>
            <option value="sunset">Sunset</option>
            <option value="mint">Mint</option>
            <option value="violet">Violet</option>
            <option value="citrus">Citrus</option>
          </select>
        </label>
        <label className="wide">Host note<textarea value={draft.hostNote} onChange={(event) => update("hostNote", event.target.value)} /></label>
      </div>
      <button className="primary" onClick={() => onUpdate(draft)}>Publish changes</button>
    </section>
  );
}

function PostsPanel({
  state,
  profile,
  role,
  onMutation
}: {
  state: EventState;
  profile: Profile;
  role: Role;
  onMutation: (op: Parameters<P2PRoomClient["sendMutation"]>[0], payload: Record<string, unknown>) => void;
}) {
  const [postBody, setPostBody] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const visiblePosts = state.posts.filter((post) => !post.deleted).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt);
  const visibleComments = state.comments.filter((comment) => !comment.deleted).sort((a, b) => b.createdAt - a.createdAt);

  function addPost() {
    if (!postBody.trim()) return;
    onMutation("post.add", { body: postBody.trim() });
    setPostBody("");
  }

  function addComment() {
    if (!commentBody.trim()) return;
    onMutation("comment.add", { body: commentBody.trim() });
    setCommentBody("");
  }

  return (
    <section className="feed glass">
      <div className="section-heading">
        <h3>Party wall</h3>
        <span>{visiblePosts.length} posts</span>
      </div>
      <div className="composer">
        <textarea value={postBody} onChange={(event) => setPostBody(event.target.value)} placeholder="Post a plan, playlist idea, ride share, or question…" />
        <button className="primary" onClick={addPost}>Post</button>
      </div>
      <div className="posts">
        {visiblePosts.map((post) => (
          <PostCard key={post.id} post={post} role={role} canDelete={isAdmin(role) || post.authorId === profile.id} onMutation={onMutation} />
        ))}
      </div>
      <div className="section-heading comment-heading">
        <h3>Comments</h3>
        <span>{visibleComments.length}</span>
      </div>
      <div className="composer compact-composer">
        <input value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Drop a comment…" />
        <button className="primary" onClick={addComment}>Send</button>
      </div>
      <div className="comments">
        {visibleComments.map((comment) => (
          <CommentRow key={comment.id} comment={comment} canDelete={isAdmin(role) || comment.authorId === profile.id} onDelete={() => onMutation("comment.delete", { id: comment.id })} />
        ))}
      </div>
    </section>
  );
}

function PostCard({
  post,
  role,
  canDelete,
  onMutation
}: {
  post: Post;
  role: Role;
  canDelete: boolean;
  onMutation: (op: Parameters<P2PRoomClient["sendMutation"]>[0], payload: Record<string, unknown>) => void;
}) {
  return (
    <article className={`post ${post.pinned ? "pinned" : ""}`}>
      <div className="post-meta">
        <strong>{post.authorName}</strong>
        <span>{new Date(post.createdAt).toLocaleString()}</span>
      </div>
      <p>{post.body}</p>
      <div className="post-actions">
        {isAdmin(role) ? <button onClick={() => onMutation("post.pin", { id: post.id, pinned: !post.pinned })}>{post.pinned ? "Unpin" : "Pin"}</button> : null}
        {canDelete ? <button onClick={() => onMutation("post.delete", { id: post.id })}>Delete</button> : null}
      </div>
    </article>
  );
}

function CommentRow({ comment, canDelete, onDelete }: { comment: Comment; canDelete: boolean; onDelete: () => void }) {
  return (
    <article className="comment">
      <div>
        <strong>{comment.authorName}</strong>
        <p>{comment.body}</p>
      </div>
      {canDelete ? <button onClick={onDelete}>×</button> : null}
    </article>
  );
}
