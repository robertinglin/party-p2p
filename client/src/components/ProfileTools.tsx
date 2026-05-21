import { FormEvent, useEffect, useRef, useState } from "react";
import type { Profile } from "../lib/types";
import { randomAvatar } from "../lib/id";

const EMOJI_CHOICES = ["🪩", "✨", "🌈", "🎧", "🔥", "🍓", "🍕", "🧃", "🎈", "🌙", "💅", "🦄", "🎤", "🕺", "💃", "🥂"];

function cleanProfile(base: Profile, name: string, avatar: string): Profile {
  return {
    ...base,
    name: name.trim() || base.name,
    avatar: avatar.trim() || randomAvatar()
  };
}

export function EmojiPicker({ value, onChange, disabled = false }: { value: string; onChange: (emoji: string) => void; disabled?: boolean }) {
  return (
    <div className="emoji-picker" aria-label="Pick an emoji">
      {EMOJI_CHOICES.map((emoji) => (
        <button
          aria-pressed={value === emoji}
          className={value === emoji ? "selected" : ""}
          disabled={disabled}
          key={emoji}
          onClick={() => onChange(emoji)}
          type="button"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

export function ProfileEditor({
  profile,
  onProfile,
  compact = false,
  title = "Your name",
  locked = false,
  statusText = "Name locked by host."
}: {
  profile: Profile;
  onProfile: (profile: Profile) => void;
  compact?: boolean;
  title?: string;
  locked?: boolean;
  statusText?: string;
}) {
  const [name, setName] = useState(profile.name);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<number>();

  useEffect(() => {
    setName(profile.name);
    setAvatar(profile.avatar);
  }, [profile.name, profile.avatar]);

  useEffect(() => () => window.clearTimeout(saveTimerRef.current), []);

  function save(event?: FormEvent) {
    event?.preventDefault();
    if (locked) return;
    onProfile(cleanProfile(profile, name, avatar));
    setSaving(true);
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => setSaving(false), 900);
  }

  return (
    <section className={compact ? "profile-card compact" : `mini-card glass profile-card ${locked ? "locked" : ""}`}>
      <div className="section-heading">
        <h3>{title}</h3>
        {!compact ? <span>{profile.avatar}</span> : null}
      </div>
      <form className="profile-form" onSubmit={save}>
        <div className="profile-fields">
          <input className="avatar-input" disabled={locked} value={avatar} onChange={(event) => setAvatar(event.target.value)} maxLength={8} aria-label="Avatar emoji" />
          <input disabled={locked} value={name} onChange={(event) => setName(event.target.value)} aria-label="Display name" />
          <button className={`secondary ${saving ? "is-loading" : ""}`} disabled={saving || locked} type="submit">
            {saving ? <span className="button-spinner" aria-hidden="true" /> : null}
            {locked ? "Locked" : saving ? "Saving" : "Save"}
          </button>
        </div>
        <EmojiPicker value={avatar} onChange={setAvatar} disabled={locked} />
        {locked ? <p className="tiny profile-lock-note">{statusText}</p> : null}
      </form>
    </section>
  );
}

export function JoinAsPanel({
  baseProfile,
  initialProfile,
  onJoin
}: {
  baseProfile: Profile;
  initialProfile?: Profile;
  onJoin: (profile: Profile) => void;
}) {
  const [name, setName] = useState(initialProfile?.name || baseProfile.name);
  const [avatar, setAvatar] = useState(initialProfile?.avatar || baseProfile.avatar);

  function submit(event: FormEvent) {
    event.preventDefault();
    onJoin(cleanProfile(baseProfile, name, avatar));
  }

  return (
    <div className="join-as-panel">
      <button className="join-as-base" onClick={() => onJoin(baseProfile)} type="button">
        <span className="avatar">{baseProfile.avatar}</span>
        <span>
          <strong>Join as {baseProfile.name}</strong>
          <small>Use your default app name</small>
        </span>
      </button>

      <form className="nickname-form" onSubmit={submit}>
        <div className="section-heading">
          <h3>Use a party nickname</h3>
          <span>just for this invite</span>
        </div>
        <div className="profile-fields">
          <input className="avatar-input" value={avatar} onChange={(event) => setAvatar(event.target.value)} maxLength={8} aria-label="Party avatar emoji" />
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Party nickname" />
          <button className="primary" type="submit">Join</button>
        </div>
        <EmojiPicker value={avatar} onChange={setAvatar} />
      </form>
    </div>
  );
}
