import React from "react";
import { BOARD, gridPos, PropertySpace, AirSpace, UtilitySpace, ColorGroup } from "./boardData";
import { GameState } from "./game";
import { TokenIcon } from "./tokens";

interface Props {
  state: GameState;
  onTileClick: (id: number) => void;
}

const bandClass = (g: ColorGroup): string =>
  ({ brown: "brown-band", lblue: "lblue-band", pink: "pink-band", orange: "orange-band", red: "red-band", yellow: "yellow-band", green: "green-band", dblue: "dblue-band" }[g]);

// Determine which edge a tile lives on (for color-band placement and text rotation)
function edgeOf(id: number): "bottom" | "top" | "left" | "right" | "corner" {
  if (id === 0 || id === 10 || id === 20 || id === 30) return "corner";
  if (id >= 1 && id <= 9) return "bottom";
  if (id >= 11 && id <= 19) return "left";
  if (id >= 21 && id <= 29) return "top";
  return "right";
}

function rotationFor(edge: ReturnType<typeof edgeOf>): string {
  // We rotate inner content so when you mentally tilt the board, names face their side.
  // Bottom = upright. Left = rotated 90 ccw. Top = rotated 180. Right = rotated 90 cw.
  if (edge === "bottom") return "rotate(0deg)";
  if (edge === "left") return "rotate(90deg)";
  if (edge === "top") return "rotate(180deg)";
  if (edge === "right") return "rotate(-90deg)";
  return "rotate(0deg)";
}

function Pip({ player }: { player: { color: string; tokenIdx?: number } }) {
  const idx = player.tokenIdx ?? 0;
  return (
    <span className="token-icon" style={{ background: `linear-gradient(135deg, #ece4d0 0%, ${player.color} 220%)` }} title={`Token ${idx}`}>
      <TokenIcon idx={idx} />
    </span>
  );
}

function PlayerPips({ state, spaceId }: { state: GameState; spaceId: number }) {
  const here = state.players.filter((p) => p.position === spaceId && !p.bankrupt);
  if (here.length === 0) return null;
  return (
    <div style={{ position: "absolute", bottom: 3, right: 3, display: "flex", gap: 2, zIndex: 10 }}>
      {here.map((p) => (
        <Pip key={p.id} player={{ color: p.color, tokenIdx: p.tokenIdx }} />
      ))}
    </div>
  );
}

function OwnerStrip({ state, spaceId }: { state: GameState; spaceId: number }) {
  const ps = state.properties[spaceId];
  if (!ps || ps.ownerId === null) return null;
  const owner = state.players[ps.ownerId];
  return (
    <div
      style={{
        position: "absolute",
        top: 2,
        right: 2,
        background: owner.color,
        borderRadius: 3,
        padding: "1px 4px",
        fontSize: 8,
        fontWeight: 800,
        color: "#0a0e1a",
        letterSpacing: 0.3,
        zIndex: 5
      }}
    >
      {owner.name.slice(0, 6).toUpperCase()}
      {ps.mortgaged ? " M" : ""}
    </div>
  );
}

function BuildingDots({ state, spaceId }: { state: GameState; spaceId: number }) {
  const ps = state.properties[spaceId];
  if (!ps || ps.buildings === 0) return null;
  const tierIcons = ["R", "I", "M", "T", "O"];
  const colors = ["#a35c25", "#6b6b6b", "#3b78b8", "#9b2929", "#1e3a8a"];
  return (
    <div style={{ position: "absolute", top: 3, left: 3, display: "flex", gap: 1, zIndex: 5 }}>
      {Array.from({ length: ps.buildings }).map((_, i) => (
        <span
          key={i}
          style={{
            background: colors[i],
            color: "#fff",
            fontSize: 8,
            fontWeight: 800,
            padding: "0px 3px",
            borderRadius: 2
          }}
        >
          {tierIcons[i]}
        </span>
      ))}
    </div>
  );
}

const CORNER_ICONS: Record<string, string> = {
  go: "$",
  jail: "JV",
  parking: "MIC",
  gotojail: "Y"
};

function CornerContent({ kind, name, sub }: { kind: string; name: string; sub?: string }) {
  // Use distinctive emoji-free serif marks for corners
  const symbols: Record<string, JSX.Element> = {
    go: <span style={{ fontSize: 30, fontWeight: 900 }}>$</span>,
    jail: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M6 21V11h12v10" /><path d="M9 21V14h6v7" /><path d="M4 21h16" /><path d="M9 11V7a3 3 0 016 0v4" />
      </svg>
    ),
    parking: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0014 0" /><path d="M12 17v4" /><path d="M8 21h8" />
      </svg>
    ),
    gotojail: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 22h8" /><path d="M12 14v8" /><path d="M5 2h14l-7 12L5 2z" />
      </svg>
    )
  };
  return (
    <>
      <div className="icon-big">{symbols[kind] ?? <span>*</span>}</div>
      <div className="corner-name">{name}</div>
      {sub && <div className="corner-sub">{sub}</div>}
    </>
  );
}

export default function Board({ state, onTileClick }: Props) {
  const cells: React.ReactNode[] = [];

  for (const sp of BOARD) {
    const { col, row } = gridPos(sp.id);
    const edge = edgeOf(sp.id);
    const innerRotate = rotationFor(edge);
    const cellStyle: React.CSSProperties = {
      gridColumn: col,
      gridRow: row,
      position: "relative"
    };
    const edgeClass =
      edge === "bottom" ? "tile-bottom" :
      edge === "left" ? "tile-left" :
      edge === "top" ? "tile-top" :
      edge === "right" ? "tile-right" : "";

    if (sp.kind === "property") {
      const p = sp as PropertySpace;
      cells.push(
        <div key={sp.id} className={`tile-base ${edgeClass}`} style={cellStyle} onClick={() => onTileClick(sp.id)}>
          <div className={`color-band ${bandClass(p.group)}`} />
          <div style={{ display: "flex", flexDirection: "column", height: "100%", transform: innerRotate, transformOrigin: "center", flex: 1 }}>
            <div className="name">{p.name}</div>
            <div className="owner-text">{p.owner}</div>
            <div className="handle">{p.handle}</div>
            <div className="price">${p.price}</div>
          </div>
          <OwnerStrip state={state} spaceId={sp.id} />
          <BuildingDots state={state} spaceId={sp.id} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "air") {
      const a = sp as AirSpace;
      cells.push(
        <div key={sp.id} className={`air-rights-tile ${edgeClass}`} style={cellStyle} onClick={() => onTileClick(sp.id)}>
          <div style={{ transform: innerRotate, transformOrigin: "center" }}>
            <div style={{ fontSize: 13, letterSpacing: 1.5 }}>AIR RIGHTS</div>
            <div className="deal">{a.deal}</div>
            <div className="price">$200</div>
          </div>
          <OwnerStrip state={state} spaceId={sp.id} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "utility") {
      const u = sp as UtilitySpace;
      cells.push(
        <div key={sp.id} className={`util-tile ${edgeClass}`} style={cellStyle} onClick={() => onTileClick(sp.id)}>
          <div style={{ transform: innerRotate, transformOrigin: "center" }}>
            <div style={{ fontSize: 11, letterSpacing: 1 }}>{u.name.toUpperCase()}</div>
            <div style={{ fontSize: 7.5, fontWeight: 500, color: "#8b6f3a", marginTop: 3 }}>4× DICE</div>
            <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3, color: "#1a1410" }}>$150</div>
          </div>
          <OwnerStrip state={state} spaceId={sp.id} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "crei") {
      cells.push(
        <div key={sp.id} className={`card-tile-style crei-bg ${edgeClass}`} style={cellStyle}>
          <div style={{ transform: innerRotate, transformOrigin: "center" }}>
            <div style={{ fontSize: 11, letterSpacing: 1.4 }}>OPPORTUNITY</div>
            <div style={{ fontSize: 8, color: "#8b6f3a", marginTop: 3, fontStyle: "italic" }}>Draw a card</div>
          </div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "gala") {
      cells.push(
        <div key={sp.id} className={`card-tile-style gala-bg ${edgeClass}`} style={cellStyle}>
          <div style={{ transform: innerRotate, transformOrigin: "center" }}>
            <div style={{ fontSize: 11, letterSpacing: 1.4 }}>CONNECTIONS</div>
            <div style={{ fontSize: 8, color: "#8b6f3a", marginTop: 3, fontStyle: "italic" }}>Draw a card</div>
          </div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "tax") {
      cells.push(
        <div key={sp.id} className={`card-tile-style tax-bg ${edgeClass}`} style={cellStyle}>
          <div style={{ transform: innerRotate, transformOrigin: "center" }}>
            <div style={{ fontSize: 11, letterSpacing: 1 }}>{sp.name.toUpperCase()}</div>
            <div style={{ fontSize: 8, fontWeight: 500, marginTop: 3, color: "#8b6f3a", fontStyle: "italic" }}>{sp.sub}</div>
          </div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "go") {
      cells.push(
        <div key={sp.id} className="corner-tile" style={cellStyle}>
          <CornerContent kind="go" name={sp.name} sub={sp.sub} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "jail") {
      cells.push(
        <div key={sp.id} className="corner-tile" style={cellStyle}>
          <CornerContent kind="jail" name={sp.name} sub={sp.sub} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "parking") {
      cells.push(
        <div key={sp.id} className="corner-tile" style={cellStyle}>
          <CornerContent kind="parking" name={sp.name} sub={sp.sub} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "gotojail") {
      cells.push(
        <div key={sp.id} className="corner-tile" style={cellStyle}>
          <CornerContent kind="gotojail" name={sp.name} sub={sp.sub} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    }
  }

  // Center area: title, tagline, opportunity/connections decorative cards, faint skyline
  cells.push(
    <div
      key="center"
      style={{
        gridColumn: "2 / 11",
        gridRow: "2 / 11",
        background: "linear-gradient(135deg, #0a0d1a 0%, #131a30 60%, #050810 100%)",
        color: "#fafaf3",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        position: "relative",
        overflow: "hidden",
        border: "1px solid rgba(212, 175, 55, 0.4)"
      }}
    >
      {/* Faint city skyline silhouette */}
      <svg className="center-skyline" viewBox="0 0 1000 240" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <g fill="#d4af37">
          <rect x="20" y="120" width="60" height="120" />
          <rect x="80" y="80" width="50" height="160" />
          <rect x="135" y="140" width="40" height="100" />
          <rect x="180" y="60" width="70" height="180" />
          <polygon points="215,60 215,40 250,40 250,60" />
          <rect x="255" y="100" width="55" height="140" />
          <rect x="315" y="130" width="40" height="110" />
          <rect x="360" y="40" width="80" height="200" />
          <polygon points="400,40 400,15 440,15 440,40" />
          <rect x="445" y="90" width="60" height="150" />
          <rect x="510" y="120" width="50" height="120" />
          <rect x="565" y="70" width="70" height="170" />
          <rect x="640" y="100" width="55" height="140" />
          <rect x="700" y="30" width="60" height="210" />
          <rect x="765" y="120" width="45" height="120" />
          <rect x="815" y="80" width="60" height="160" />
          <rect x="880" y="140" width="40" height="100" />
          <rect x="925" y="100" width="60" height="140" />
        </g>
      </svg>

      {/* Decorative tilted cards */}
      <div className="center-card" style={{ top: "12%", left: "8%", transform: "rotate(-8deg)", fontSize: 11, color: "#6b4f1a" }}>
        OPPORTUNITY
      </div>
      <div className="center-card" style={{ top: "16%", right: "8%", transform: "rotate(7deg)", fontSize: 11, color: "#6b4f1a" }}>
        CONNECTIONS
      </div>

      <div
        className="gold-text serif"
        style={{
          fontSize: 86,
          fontWeight: 900,
          letterSpacing: -1.5,
          lineHeight: 1,
          textShadow: "0 4px 30px rgba(212,175,55,0.3)",
          marginTop: 30,
          zIndex: 2
        }}
      >
        X-OPOLY
      </div>
      <div
        style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 12,
          letterSpacing: 4,
          color: "#d4af37",
          textTransform: "uppercase",
          marginTop: 6,
          fontWeight: 500,
          textAlign: "center",
          maxWidth: 480,
          zIndex: 2
        }}
      >
        The Real Estate Game of Strategy, Connections &amp; Capital
      </div>

      <div
        style={{
          marginTop: 18,
          padding: "10px 14px",
          border: "1px solid rgba(212,175,55,0.35)",
          borderRadius: 8,
          background: "rgba(212,175,55,0.06)",
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 10,
          letterSpacing: 3,
          color: "#cfd6ea",
          textTransform: "uppercase",
          zIndex: 2
        }}
      >
        Presented by Real Estate AI Studio
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 30,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 11,
          letterSpacing: 4,
          color: "#d4af37",
          textTransform: "uppercase",
          fontStyle: "italic",
          zIndex: 2
        }}
      >
        Build relationships · Make moves · Create real impact
      </div>
    </div>
  );

  return (
    <div className="iso-stage">
      <div
        className="board-iso"
        style={{
          display: "grid",
          gridTemplateColumns: "120px repeat(9, 80px) 120px",
          gridTemplateRows: "120px repeat(9, 80px) 120px",
          gap: 2,
          background: "linear-gradient(135deg, #2a2418 0%, #4a3a1a 50%, #2a2418 100%)",
          padding: 4,
          borderRadius: 14,
          boxShadow: "0 50px 120px rgba(0, 0, 0, 0.85), 0 0 0 6px #1a1410, 0 0 0 7px #d4af37"
        }}
      >
        {cells}
      </div>
    </div>
  );
}
