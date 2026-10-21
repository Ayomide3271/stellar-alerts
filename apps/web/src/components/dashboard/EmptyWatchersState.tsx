import React from 'react';

interface EmptyWatchersStateProps {
  /**
   * Number of wallets the dashboard currently has. The card owns the
   * "empty" rule so every caller hides it the same way: pass the count,
   * render unconditionally.
   */
  walletCount: number;
  /** Opens the Add Wallet flow (the dashboard scrolls to the watcher form). */
  onAddWallet: () => void;
}

/**
 * Onboarding card shown while a user has no registered wallets.
 *
 * The dashboard's ledger, charts and watchers table are all meaningless at
 * zero wallets, so this replaces the blank table with an explanation of the
 * real-time alerting the app provides and one obvious next action.
 */
export const EmptyWatchersState: React.FC<EmptyWatchersStateProps> = ({
  walletCount,
  onAddWallet,
}) => {
  if (walletCount > 0) return null;

  return (
    <section
      data-testid="empty-watchers-state"
      aria-labelledby="empty-watchers-title"
      aria-describedby="empty-watchers-description"
      className="relative overflow-hidden rounded-3xl border border-cyan-500/20 bg-gradient-to-r from-cyan-950/40 via-blue-950/30 to-purple-950/20 p-8 sm:p-10 backdrop-blur-xl shadow-2xl"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-purple-500/10 blur-3xl"
      />

      <div className="relative flex flex-col-reverse items-center gap-8 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl text-center md:text-left">
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-300">
            <span aria-hidden="true">✦</span> Getting started
          </span>

          <h2
            id="empty-watchers-title"
            className="mt-4 text-2xl font-extrabold tracking-tight text-white sm:text-3xl"
          >
            Watch your first Stellar wallet
          </h2>

          <p id="empty-watchers-description" className="mt-2 text-sm text-slate-400">
            Register a Stellar public key and Stellar Alerts streams every incoming payment in
            real time. You get notified the moment funds move, with the full history kept in one
            ledger.
          </p>

          <ul className="mt-5 grid gap-3 text-left text-sm text-slate-300 sm:grid-cols-3">
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="text-cyan-400">
                ◈
              </span>
              <span>Live Horizon stream, no refresh</span>
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="text-cyan-400">
                ◈
              </span>
              <span>Alerts the second funds arrive</span>
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="text-cyan-400">
                ◈
              </span>
              <span>Every payment searchable later</span>
            </li>
          </ul>

          <button
            type="button"
            onClick={onAddWallet}
            data-testid="empty-watchers-cta"
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-600/20 transition-all duration-200 hover:bg-purple-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            <span aria-hidden="true">+</span> Add Your First Wallet
          </button>
        </div>

        <EmptyWatchersIllustration />
      </div>
    </section>
  );
};

/** Decorative wallet-with-signal artwork. Hidden from assistive tech. */
const EmptyWatchersIllustration: React.FC = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 240 180"
    className="h-40 w-auto shrink-0 sm:h-48"
  >
    <defs>
      <linearGradient id="empty-watchers-wallet" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.35" />
        <stop offset="100%" stopColor="#a855f7" stopOpacity="0.35" />
      </linearGradient>
    </defs>

    {/* Signal arcs: the "real-time" part of the illustration. */}
    <g fill="none" stroke="#22d3ee" strokeLinecap="round">
      <path d="M170 44a42 42 0 0 1 0 60" strokeWidth="2" strokeOpacity="0.55" />
      <path d="M184 30a62 62 0 0 1 0 88" strokeWidth="2" strokeOpacity="0.35" />
      <path d="M198 16a82 82 0 0 1 0 116" strokeWidth="2" strokeOpacity="0.2" />
    </g>

    {/* Wallet body. */}
    <rect
      x="34"
      y="56"
      width="132"
      height="88"
      rx="16"
      fill="url(#empty-watchers-wallet)"
      stroke="#22d3ee"
      strokeOpacity="0.45"
      strokeWidth="2"
    />
    <path d="M34 80h132" stroke="#a855f7" strokeOpacity="0.35" strokeWidth="2" />
    <rect
      x="120"
      y="94"
      width="46"
      height="28"
      rx="10"
      fill="#0f172a"
      stroke="#a855f7"
      strokeOpacity="0.5"
      strokeWidth="2"
    />
    <circle cx="136" cy="108" r="4" fill="#22d3ee" />
    <path
      d="M58 128h34"
      stroke="#94a3b8"
      strokeOpacity="0.45"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);
