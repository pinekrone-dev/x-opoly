import React from "react";

// Classic Monopoly tokens. Inline SVG, simple silhouettes.
export const TOKENS = ["TopHat", "RaceCar", "Dog", "Boot", "Thimble", "Battleship", "Wheelbarrow", "Iron"];

export function tokenIconForPlayer(playerId: number): number {
  return playerId % TOKENS.length;
}

export function TokenIcon({ idx }: { idx: number }) {
  const i = ((idx % TOKENS.length) + TOKENS.length) % TOKENS.length;
  switch (i) {
    case 0:
      return (
        // Top hat
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 19h14" />
          <rect x="7" y="5" width="10" height="13" rx="0.6" />
          <line x1="7" y1="9" x2="17" y2="9" />
        </svg>
      );
    case 1:
      return (
        // Race car
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 14l2-4h14l2 4v3H3z" />
          <circle cx="7" cy="17" r="1.6" />
          <circle cx="17" cy="17" r="1.6" />
        </svg>
      );
    case 2:
      return (
        // Dog (scotty)
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 17V11l3-3h6l3 3v6" />
          <path d="M14 8V5h2v3" />
          <line x1="9" y1="14" x2="9" y2="14.01" />
          <line x1="5" y1="17" x2="5" y2="20" />
          <line x1="17" y1="17" x2="17" y2="20" />
        </svg>
      );
    case 3:
      return (
        // Boot
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 4v9H5v6h14v-3a4 4 0 00-4-4h-2V4z" />
        </svg>
      );
    case 4:
      return (
        // Thimble
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 19V9a5 5 0 0110 0v10z" />
          <line x1="9" y1="11" x2="15" y2="11" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      );
    case 5:
      return (
        // Battleship
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 16h18l-2 4H5z" />
          <line x1="12" y1="6" x2="12" y2="14" />
          <path d="M9 10h6" />
          <path d="M10 14V8h4v6" />
        </svg>
      );
    case 6:
      return (
        // Wheelbarrow
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 14l3-6h9l3 6z" />
          <circle cx="9" cy="18" r="1.6" />
          <line x1="19" y1="14" x2="22" y2="17" />
        </svg>
      );
    case 7:
      return (
        // Iron
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 17l3-7h10l2 7z" />
          <line x1="6" y1="17" x2="20" y2="17" />
          <path d="M11 6h2v2" />
        </svg>
      );
    default:
      return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor" /></svg>;
  }
}
