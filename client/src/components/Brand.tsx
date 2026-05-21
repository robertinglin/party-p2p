export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect className="brand-mark-base" x="3" y="3" width="42" height="42" rx="14" />
      <path className="brand-mark-link" d="M15 18L24 24L33 18M24 24L16 31M24 24L32 31" />
      <circle className="brand-mark-node primary-node" cx="15" cy="18" r="4" />
      <circle className="brand-mark-node primary-node" cx="33" cy="18" r="4" />
      <circle className="brand-mark-node" cx="24" cy="24" r="4.4" />
      <circle className="brand-mark-node secondary-node" cx="16" cy="31" r="3.8" />
      <circle className="brand-mark-node secondary-node" cx="32" cy="31" r="3.8" />
    </svg>
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-lockup ${compact ? "compact" : ""}`} aria-label="Party P2P">
      <BrandMark />
      <span className="brand-wordmark" aria-hidden="true">
        <span>Party</span>
        <strong>P2P</strong>
      </span>
    </div>
  );
}
