import React from "react";

export const TOKEN_NAMES = [
  "Top Hat",
  "Race Car",
  "Scotty Dog",
  "Boot",
  "Thimble",
  "Battleship",
  "Wheelbarrow",
  "Iron"
];

export const TOKEN_COUNT = TOKEN_NAMES.length;

// 3D-shaded SVGs for each token: linearGradient + radial highlight + cast shadow
export function TokenIcon({ idx, size = 24 }: { idx: number; size?: number }) {
  const i = ((idx % TOKEN_COUNT) + TOKEN_COUNT) % TOKEN_COUNT;
  const gradId = `tk-grad-${i}`;
  const shadowId = `tk-shadow-${i}`;
  const common = (
    <defs>
      <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#f5e3a0" />
        <stop offset="45%" stopColor="#d4af37" />
        <stop offset="100%" stopColor="#7a5e16" />
      </linearGradient>
      <filter id={shadowId} x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0.6" dy="1.2" stdDeviation="0.8" floodColor="#000" floodOpacity="0.55" />
      </filter>
      <radialGradient id={`hl-${i}`} cx="35%" cy="25%" r="60%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
        <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
  const fill = `url(#${gradId})`;
  const filter = `url(#${shadowId})`;
  const props = { fill, stroke: "#3b2a08", strokeWidth: 0.6, filter };

  switch (i) {
    case 0:
      // Top hat
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="12" ry="2.2" fill="#000" opacity="0.35" />
          <path d="M9 24h14v2H9z" {...props} />
          <path d="M11 7h10v18H11z" {...props} />
          <path d="M11 13h10" stroke="#3b2a08" strokeWidth="0.7" fill="none" />
          <ellipse cx="13.5" cy="10" rx="1.5" ry="3.2" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 1:
      // Race car
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="12" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M3 19l3-5h6l3-3h6l4 3 4 5v3H3z" {...props} />
          <circle cx="9" cy="23" r="2.8" fill="#1a1410" stroke="#3b2a08" strokeWidth="0.5" />
          <circle cx="23" cy="23" r="2.8" fill="#1a1410" stroke="#3b2a08" strokeWidth="0.5" />
          <circle cx="9" cy="23" r="1.1" fill="#888" />
          <circle cx="23" cy="23" r="1.1" fill="#888" />
          <path d="M14 13h5" stroke="#3b2a08" strokeWidth="0.5" fill="none" />
          <ellipse cx="11" cy="16" rx="3" ry="0.8" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 2:
      // Scotty Dog
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="28" rx="11" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M5 22V14l3-3h6V8h3v3l4 1 5 4v6z" {...props} />
          <circle cx="20" cy="14" r="0.8" fill="#1a1410" />
          <path d="M22 13l3-1" stroke="#3b2a08" strokeWidth="0.6" />
          <path d="M7 22v3M11 22v3M19 22v3M23 22v3" stroke="#3b2a08" strokeWidth="0.7" />
          <ellipse cx="9" cy="16" rx="2.6" ry="1" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 3:
      // Boot
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="11" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M11 4v15H6v6h21v-3a5 5 0 00-5-5h-4V4z" {...props} />
          <path d="M11 12h7" stroke="#3b2a08" strokeWidth="0.6" />
          <ellipse cx="13" cy="10" rx="1.4" ry="3.5" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 4:
      // Thimble
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="9" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M9 25V12a7 7 0 0114 0v13z" {...props} />
          <path d="M11 14h10M11 17h10M11 20h10" stroke="#3b2a08" strokeWidth="0.6" />
          <ellipse cx="13" cy="11" rx="2" ry="3" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 5:
      // Battleship
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="12" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M3 22h26l-3 4H6z" {...props} />
          <path d="M14 12h6v9h-6z" {...props} />
          <line x1="16" y1="6" x2="16" y2="12" stroke="#3b2a08" strokeWidth="0.8" />
          <line x1="13" y1="9" x2="19" y2="9" stroke="#3b2a08" strokeWidth="0.6" />
          <ellipse cx="8" cy="24" rx="3" ry="0.7" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 6:
      // Wheelbarrow
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="11" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M5 17l4-7h13l4 7z" {...props} />
          <circle cx="11" cy="22" r="3" fill="#1a1410" stroke="#3b2a08" strokeWidth="0.5" />
          <circle cx="11" cy="22" r="1.2" fill="#888" />
          <path d="M22 17l5 4" stroke="#3b2a08" strokeWidth="0.8" />
          <ellipse cx="11" cy="13" rx="3" ry="0.7" fill={`url(#hl-${i})`} />
        </svg>
      );
    case 7:
      // Iron
      return (
        <svg viewBox="0 0 32 32" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
          {common}
          <ellipse cx="16" cy="27" rx="11" ry="1.6" fill="#000" opacity="0.35" />
          <path d="M4 22l5-10h14l3 10z" {...props} />
          <path d="M14 8h4v3" stroke="#3b2a08" strokeWidth="0.7" fill="none" />
          <ellipse cx="11" cy="15" rx="3" ry="0.8" fill={`url(#hl-${i})`} />
        </svg>
      );
    default:
      return null;
  }
}

export function tokenIconForPlayer(playerId: number): number {
  return playerId % TOKEN_COUNT;
}
