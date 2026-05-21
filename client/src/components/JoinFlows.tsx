import type { Profile, RoomConfig, SavedInvite } from "../lib/types";
import { partyTimingLabel } from "../lib/eventTime";
import { JoinAsPanel, ProfileEditor } from "./ProfileTools";

function inviteTitle(invite: SavedInvite): string {
  return invite.details?.title || invite.config.roomName;
}

function inviteMeta(invite: SavedInvite): string {
  if (!invite.details) return invite.acceptedAt ? "Invite accepted" : "Invite saved";
  return partyTimingLabel(invite.details);
}

function SavedInviteCard({
  invite,
  onOpenInvite,
  onForgetInvite
}: {
  invite: SavedInvite;
  onOpenInvite: (config: RoomConfig) => void;
  onForgetInvite: (id: string) => void;
}) {
  return (
    <article className="invite-card">
      <button className="invite-main" onClick={() => onOpenInvite(invite.config)} type="button">
        <span className="invite-avatar">{invite.profile?.avatar || invite.details?.coverEmoji || "🪩"}</span>
        <span>
          <strong>{inviteTitle(invite)}</strong>
          <small>{inviteMeta(invite)}</small>
          {invite.details?.location ? <small>{invite.details.location}</small> : null}
        </span>
      </button>
      <div className="invite-actions">
        {invite.profile ? <span>as {invite.profile.name}</span> : null}
        <button className="secondary" onClick={() => onForgetInvite(invite.id)} type="button">Forget</button>
      </div>
    </article>
  );
}

export function RootScreen({
  baseProfile,
  savedInvites,
  onBaseProfile,
  onOpenInvite,
  onForgetInvite
}: {
  baseProfile: Profile;
  savedInvites: SavedInvite[];
  onBaseProfile: (profile: Profile) => void;
  onOpenInvite: (config: RoomConfig) => void;
  onForgetInvite: (id: string) => void;
}) {
  return (
    <main className="app theme-sunset">
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <div className="root-layout">
        <section className="root-hero glass">
          <p className="brand-kicker">Party P2P</p>
          <h1>Your invites, ready to rejoin.</h1>
          <p className="lede">Room links stay on this device once opened so the root app can get you back into the right party without digging through messages.</p>
          <ProfileEditor profile={baseProfile} onProfile={onBaseProfile} compact title="Default name" />
        </section>

        <section className="invite-panel glass">
          <div className="section-heading">
            <h3>Saved invites</h3>
            <span>{savedInvites.length}</span>
          </div>
          {savedInvites.length ? (
            <div className="saved-invites">
              {savedInvites.map((invite) => (
                <SavedInviteCard invite={invite} key={invite.id} onOpenInvite={onOpenInvite} onForgetInvite={onForgetInvite} />
              ))}
            </div>
          ) : (
            <p className="empty-invites">Open an invite link once. It will show up here for quick rejoin.</p>
          )}
        </section>
      </div>
    </main>
  );
}

export function JoinInviteScreen({
  config,
  savedInvite,
  baseProfile,
  onAccept,
  onBack
}: {
  config: RoomConfig;
  savedInvite?: SavedInvite;
  baseProfile: Profile;
  onAccept: (profile: Profile) => void;
  onBack: () => void;
}) {
  const details = savedInvite?.details;
  const title = details?.title || config.roomName;

  return (
    <main className={`app theme-${details?.theme || "sunset"}`}>
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <section className="join-shell glass">
        <p className="brand-kicker">Invite found</p>
        <h1>Join {title}</h1>
        <p className="lede">{details ? partyTimingLabel(details) : "Choose how you want to show up before connecting to the host."}</p>
        {details?.location ? <p className="event-place">📍 {details.location}</p> : null}
        <JoinAsPanel baseProfile={baseProfile} initialProfile={savedInvite?.profile} onJoin={onAccept} />
        <button className="secondary back-button" onClick={onBack} type="button">Back to invites</button>
      </section>
    </main>
  );
}
