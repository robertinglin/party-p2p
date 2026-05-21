import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { P2PRoomClient } from "./lib/peerRoom";
import type { Comment, EventDetails, EventState, Guest, Post, Profile, Role, RoomConfig, Rsvp, SavedInvite } from "./lib/types";
import { roomToPeerId, slugifyRoom } from "./lib/id";
import { buildRoomUrl, parseRoomConfig } from "./lib/roomLink";
import { downloadBackup, loadEncryptedBackup, loadProfile, loadSavedInvites, removeSavedInvite, saveAcceptedInvite, saveInviteSnapshot, saveOpenedInvite, saveProfile } from "./lib/storage";
import { LocationMap, MapPinEditor } from "./components/OpenStreetMap";
import { openStreetMapUrl } from "./lib/map";
import { BrandLockup } from "./components/Brand";
import { JoinInviteScreen, RootScreen } from "./components/JoinFlows";
import { ProfileEditor } from "./components/ProfileTools";

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

function normalizeRoomConfig(config: RoomConfig): RoomConfig {
  const roomName = slugifyRoom(config.roomName);
  return {
    ...config,
    roomName,
    roomPeerId: config.roomPeerId || roomToPeerId(roomName)
  };
}

function sameRoomConfig(left: RoomConfig | undefined, right: RoomConfig | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.roomName === right.roomName &&
      left.roomPeerId === right.roomPeerId &&
      left.roomSecret === right.roomSecret
  );
}

function savedInviteFor(invites: SavedInvite[], config: RoomConfig | undefined): SavedInvite | undefined {
  if (!config) return undefined;
  return invites.find(
    (invite) =>
      invite.config.roomName === config.roomName &&
      invite.config.roomPeerId === config.roomPeerId &&
      invite.config.roomSecret === config.roomSecret
  );
}

export default function App() {
  const [routeConfig, setRouteConfig] = useState<RoomConfig | undefined>(() => parseRoomConfig());
  const [activeConfig, setActiveConfig] = useState<RoomConfig | undefined>();
  const [baseProfile, setBaseProfile] = useState<Profile>(() => loadProfile());
  const [activeProfile, setActiveProfile] = useState<Profile>(() => baseProfile);
  const [savedInvites, setSavedInvites] = useState<SavedInvite[]>(() => loadSavedInvites());
  const [state, setState] = useState<EventState | undefined>();
  const [role, setRole] = useState<Role>("guest");
  const [status, setStatus] = useState<Status>("idle");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const clientRef = useRef<P2PRoomClient | undefined>(undefined);
  const config = activeConfig;

  useEffect(() => {
    function syncRoomConfigFromHash() {
      setRouteConfig(parseRoomConfig());
    }

    window.addEventListener("hashchange", syncRoomConfigFromHash);
    window.addEventListener("popstate", syncRoomConfigFromHash);
    return () => {
      window.removeEventListener("hashchange", syncRoomConfigFromHash);
      window.removeEventListener("popstate", syncRoomConfigFromHash);
    };
  }, []);

  useEffect(() => {
    if (!routeConfig) {
      setActiveConfig(undefined);
      return;
    }

    const normalized = normalizeRoomConfig(routeConfig);
    const nextInvites = saveOpenedInvite(normalized);
    const savedInvite = savedInviteFor(nextInvites, normalized);
    setSavedInvites(nextInvites);

    if (savedInvite?.acceptedAt && savedInvite.profile) {
      setActiveProfile(savedInvite.profile);
      setActiveConfig((current) => (sameRoomConfig(current, normalized) ? current : normalized));
      return;
    }

    setActiveConfig((current) => (sameRoomConfig(current, normalized) ? current : undefined));
  }, [routeConfig?.roomName, routeConfig?.roomPeerId, routeConfig?.roomSecret]);

  useEffect(() => {
    if (!activeConfig) {
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

    const client = new P2PRoomClient(activeConfig, activeProfile, {
      onStatus: (next, detail) => {
        if (cancelled) return;
        setStatus(next);
        setStatusDetail(detail || "");
      },
      onState: (nextState) => {
        if (cancelled) return;
        setState(nextState);
        setSavedInvites(saveInviteSnapshot(activeConfig, activeProfile, nextState.details, nextState.updatedAt));
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
    void loadEncryptedBackup(activeConfig.roomName, activeConfig.roomSecret).then((backup) => {
      if (!cancelled && backup) setState(backup);
    });
    void client.start();

    return () => {
      cancelled = true;
      client.destroy();
      if (clientRef.current === client) clientRef.current = undefined;
    };
  }, [activeConfig?.roomName, activeConfig?.roomPeerId, activeConfig?.roomSecret, activeProfile.id]);

  function send(op: Parameters<P2PRoomClient["sendMutation"]>[0], payload: Record<string, unknown>) {
    clientRef.current?.sendMutation(op, payload);
  }

  function updateBaseProfile(nextProfile: Profile) {
    setBaseProfile(nextProfile);
    saveProfile(nextProfile);
  }

  function updateActiveProfile(nextProfile: Profile) {
    if (state?.guests[nextProfile.id]?.nameLocked) {
      setToast("Name locked by host.");
      return;
    }

    setActiveProfile(nextProfile);
    if (activeConfig) {
      setSavedInvites(state ? saveInviteSnapshot(activeConfig, nextProfile, state.details, state.updatedAt) : saveAcceptedInvite(activeConfig, nextProfile));
    }
    send("guest.update", { name: nextProfile.name, avatar: nextProfile.avatar });
  }

  function openInvite(nextConfig: RoomConfig) {
    const normalized = normalizeRoomConfig(nextConfig);
    window.history.pushState(null, "", buildRoomUrl(normalized));
    setRouteConfig(normalized);
    setActiveConfig(undefined);
    setState(undefined);
  }

  function acceptInvite(nextProfile: Profile) {
    if (!routeConfig) return;
    const normalized = normalizeRoomConfig(routeConfig);
    setActiveProfile(nextProfile);
    setSavedInvites(saveAcceptedInvite(normalized, nextProfile));
    setActiveConfig(normalized);
  }

  function backToRoot() {
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    setRouteConfig(undefined);
    setActiveConfig(undefined);
    setState(undefined);
  }

  if (routeConfig && !activeConfig) {
    return (
      <JoinInviteScreen
        baseProfile={baseProfile}
        config={routeConfig}
        onAccept={acceptInvite}
        onBack={backToRoot}
        savedInvite={savedInviteFor(savedInvites, normalizeRoomConfig(routeConfig))}
      />
    );
  }

  if (!config) {
    return (
      <RootScreen
        baseProfile={baseProfile}
        onBaseProfile={updateBaseProfile}
        onForgetInvite={(id) => setSavedInvites(removeSavedInvite(id))}
        onOpenInvite={openInvite}
        savedInvites={savedInvites}
      />
    );
  }

  return (
    <main className={`app theme-${state?.details.theme || "sunset"}`}>
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <header className="topbar glass">
        <div>
          <BrandLockup compact />
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
          profile={activeProfile}
          config={config}
          onProfile={updateActiveProfile}
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
  const visibleProfile = currentGuest
    ? { ...profile, name: currentGuest.name, avatar: currentGuest.avatar }
    : profile;

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
        <ProfileEditor
          profile={visibleProfile}
          onProfile={onProfile}
          locked={Boolean(currentGuest?.nameLocked)}
          statusText="Name locked by host."
        />
        <BackupCard version={state.version} updatedAt={state.updatedAt} onDownloadBackup={onDownloadBackup} />
      </aside>

      <section className="content-stack">
        {isAdmin(role) ? <AdminPanel details={state.details} onUpdate={(details) => onMutation("event.update", details as unknown as Record<string, unknown>)} /> : null}
        <PostsPanel state={state} profile={profile} role={role} onMutation={onMutation} />
      </section>

      <aside className="side-stack guests-stack">
        <GuestList guests={state.guests} adminIds={state.adminIds} canModerate={isAdmin(role)} onMutation={onMutation} />
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
    await navigator.clipboard?.writeText(shareUrl).catch(() => undefined);
  }

  return (
    <section className="mini-card glass share-card">
      <div className="section-heading">
        <h3>Secure room QR</h3>
        <span>share link</span>
      </div>
      {qr ? <img className="qr" src={qr} alt="QR code for this room" /> : <div className="qr skeleton" />}
      <input className="share-link" readOnly value={shareUrl} aria-label="Invite link" />
      <button className="secondary" onClick={copy}>Copy invite link</button>
      <p className="tiny">The room secret is in the URL hash, so it is not sent to the static web server.</p>
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

function GuestList({
  guests,
  adminIds,
  canModerate,
  onMutation
}: {
  guests: Record<string, Guest>;
  adminIds: string[];
  canModerate: boolean;
  onMutation: (op: Parameters<P2PRoomClient["sendMutation"]>[0], payload: Record<string, unknown>) => void;
}) {
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
            <div className="guest-body">
              <strong className="scroll-text" title={guest.name}>{guest.name}</strong>
              <div className="guest-meta">
                <small>{adminIds.includes(guest.id) ? "admin" : guest.rsvp}</small>
                {guest.nameLocked ? <small>name locked</small> : null}
                {guest.chatDisabled ? <small>chat muted</small> : null}
              </div>
            </div>
            {canModerate ? (
              <div className="moderation-actions">
                <button type="button" onClick={() => onMutation("guest.moderate", { guestId: guest.id, nameLocked: !guest.nameLocked })}>
                  {guest.nameLocked ? "Unlock name" : "Lock name"}
                </button>
                <button type="button" onClick={() => onMutation("guest.moderate", { guestId: guest.id, chatDisabled: !guest.chatDisabled })}>
                  {guest.chatDisabled ? "Allow chat" : "Mute chat"}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminPanel({ details, onUpdate }: { details: EventDetails; onUpdate: (details: Partial<EventDetails>) => void }) {
  const [draft, setDraft] = useState(details);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<number>();

  useEffect(() => setDraft(details), [details]);
  useEffect(() => () => window.clearTimeout(saveTimerRef.current), []);

  function update<K extends keyof EventDetails>(key: K, value: EventDetails[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function publishChanges() {
    onUpdate(draft);
    setSaving(true);
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => setSaving(false), 900);
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
      <button className={`primary ${saving ? "is-loading" : ""}`} disabled={saving} onClick={publishChanges}>
        {saving ? <span className="button-spinner" aria-hidden="true" /> : null}
        {saving ? "Saving" : "Publish changes"}
      </button>
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
  const currentGuest = state.guests[profile.id];
  const postingDisabled = Boolean(currentGuest?.chatDisabled);
  const visiblePosts = state.posts.filter((post) => !post.deleted).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt);
  const visibleComments = state.comments.filter((comment) => !comment.deleted).sort((a, b) => b.createdAt - a.createdAt);

  function addPost() {
    if (postingDisabled) return;
    if (!postBody.trim()) return;
    onMutation("post.add", { body: postBody.trim() });
    setPostBody("");
  }

  function addComment() {
    if (postingDisabled) return;
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
      {postingDisabled ? <p className="tiny moderation-note">Posting disabled by host.</p> : null}
      <div className="composer">
        <textarea disabled={postingDisabled} value={postBody} onChange={(event) => setPostBody(event.target.value)} placeholder="Post a plan, playlist idea, ride share, or question…" />
        <button className="primary" disabled={postingDisabled} onClick={addPost}>Post</button>
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
        <input disabled={postingDisabled} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Drop a comment…" />
        <button className="primary" disabled={postingDisabled} onClick={addComment}>Send</button>
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
