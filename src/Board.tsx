import React from "react";
import { BOARD, gridPos, PropertySpace, AirSpace, UtilitySpace, ColorGroup } from "./boardData";
import { GameState } from "./game";

interface Props {
  state: GameState;
  onTileClick: (id: number) => void;
}

const colorClass = (g: ColorGroup): string =>
  ({ brown: "brown-bg", lblue: "lblue-bg", pink: "pink-bg", orange: "orange-bg", red: "red-bg", yellow: "yellow-bg", green: "green-bg", dblue: "dblue-bg" }[g]);

function Pip({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="token-pip"
      title={label}
      style={{ background: color, marginRight: 2 }}
    />
  );
}

function PlayerPips({ state, spaceId }: { state: GameState; spaceId: number }) {
  const here = state.players.filter((p) => p.position === spaceId && !p.bankrupt);
  if (here.length === 0) return null;
  return (
    <div style={{ position: "absolute", bottom: 2, right: 2, display: "flex" }}>
      {here.map((p) => (
        <Pip key={p.id} color={p.color} label={p.name} />
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
        left: 2,
        background: owner.color,
        borderRadius: 3,
        padding: "1px 4px",
        fontSize: 8,
        fontWeight: 800,
        color: "#0a0e1a",
        letterSpacing: 0.3
      }}
    >
      {owner.name.slice(0, 8).toUpperCase()}
      {ps.mortgaged ? " ✕" : ""}
    </div>
  );
}

function BuildingDots({ state, spaceId }: { state: GameState; spaceId: number }) {
  const ps = state.properties[spaceId];
  if (!ps || ps.buildings === 0) return null;
  const tierIcons = ["R", "I", "M", "T", "O"];
  const colors = ["#f0a060", "#a0a0a0", "#7088c0", "#c66060", "#3070a0"];
  return (
    <div style={{ position: "absolute", top: 18, left: 2, display: "flex", gap: 1 }}>
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

export default function Board({ state, onTileClick }: Props) {
  const cells: React.ReactNode[] = [];

  for (const sp of BOARD) {
    const { col, row } = gridPos(sp.id);
    const style: React.CSSProperties = {
      gridColumn: col,
      gridRow: row,
      position: "relative"
    };
    if (sp.kind === "property") {
      const p = sp as PropertySpace;
      cells.push(
        <div key={sp.id} className="tile-base" style={style} onClick={() => onTileClick(sp.id)}>
          <div className={`color-band ${colorClass(p.group)}`} />
          <div style={{ fontWeight: 700, fontSize: 8.5, textTransform: "uppercase", letterSpacing: 0.2 }}>{p.name}</div>
          <div style={{ fontSize: 7.5, color: "#555" }}>{p.owner}</div>
          <div style={{ fontSize: 7, color: "#d4af37", fontWeight: 600 }}>{p.handle}</div>
          <div style={{ marginTop: "auto", fontSize: 9, fontWeight: 700, color: "#111" }}>${p.price}</div>
          <OwnerStrip state={state} spaceId={sp.id} />
          <BuildingDots state={state} spaceId={sp.id} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "air") {
      const a = sp as AirSpace;
      cells.push(
        <div key={sp.id} className="air-rights-tile" style={style} onClick={() => onTileClick(sp.id)}>
          <div style={{ fontSize: 16 }}>AIR</div>
          <div>AIR RIGHTS</div>
          <div style={{ fontSize: 7.5, color: "#fafaf3", fontStyle: "italic", marginTop: 2 }}>{a.deal}</div>
          <div style={{ fontSize: 9, color: "#d4af37", marginTop: 1 }}>$200</div>
          <OwnerStrip state={state} spaceId={sp.id} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "utility") {
      const u = sp as UtilitySpace;
      cells.push(
        <div key={sp.id} className="util-tile" style={style} onClick={() => onTileClick(sp.id)}>
          <div style={{ fontSize: 16 }}>UTIL</div>
          <div>{u.name.toUpperCase()}</div>
          <div style={{ fontSize: 7.5, color: "#666", fontWeight: 500, marginTop: 2 }}>Pay 4× dice</div>
          <div style={{ fontSize: 9, fontWeight: 700, marginTop: 2, color: "#111" }}>$150</div>
          <OwnerStrip state={state} spaceId={sp.id} />
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "crei") {
      cells.push(
        <div key={sp.id} className="card-tile-style crei-bg" style={style}>
          <div style={{ fontSize: 16 }}>CR</div>
          <div>CREi SUMMIT</div>
          <div style={{ fontSize: 8, color: "#666", marginTop: 2 }}>Draw a card</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "gala") {
      cells.push(
        <div key={sp.id} className="card-tile-style gala-bg" style={style}>
          <div style={{ fontSize: 16 }}>RE</div>
          <div>RE GALA</div>
          <div style={{ fontSize: 8, color: "#666", marginTop: 2 }}>Draw a card</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "tax") {
      cells.push(
        <div key={sp.id} className="card-tile-style tax-bg" style={style}>
          <div style={{ fontSize: 16 }}>$$</div>
          <div>{sp.name.toUpperCase()}</div>
          <div style={{ fontSize: 8, color: "#666", fontWeight: 500, marginTop: 2 }}>{sp.sub}</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "go") {
      cells.push(
        <div key={sp.id} className="corner-tile corner-go" style={style}>
          <div style={{ fontSize: 22 }}>GO</div>
          <div>CLOSING DAY</div>
          <div style={{ color: "#c00", fontSize: 26, fontWeight: 900 }}>←</div>
          <div style={{ fontSize: 9, fontWeight: 600, color: "#555" }}>Collect $200</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "jail") {
      cells.push(
        <div key={sp.id} className="corner-tile corner-jail" style={style}>
          <div style={{ fontSize: 22 }}>HOLD</div>
          <div>OFAC HOLD</div>
          <div style={{ fontSize: 9, fontWeight: 600, color: "#555" }}>Just visiting</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "parking") {
      cells.push(
        <div key={sp.id} className="corner-tile corner-parking" style={style}>
          <div style={{ fontSize: 22 }}>1031</div>
          <div>FREE PARKING</div>
          <div style={{ fontSize: 9, fontWeight: 600, color: "#555" }}>1031 ID Window</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    } else if (sp.kind === "gotojail") {
      cells.push(
        <div key={sp.id} className="corner-tile corner-gotojail" style={style}>
          <div style={{ fontSize: 22 }}>!!</div>
          <div>DSCR FAILED</div>
          <div style={{ fontSize: 9, fontWeight: 600, color: "#555" }}>Go to OFAC</div>
          <PlayerPips state={state} spaceId={sp.id} />
        </div>
      );
    }
  }

  // center
  cells.push(
    <div
      key="center"
      style={{
        gridColumn: "2 / 11",
        gridRow: "2 / 11",
        background: "linear-gradient(135deg, #0f1b3a 0%, #1a2245 100%)",
        color: "#fafaf3",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        position: "relative",
        overflow: "hidden"
      }}
    >
      <div
        className="gold-text"
        style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 92,
          fontWeight: 900,
          letterSpacing: -2,
          lineHeight: 1
        }}
      >
        X-opoly
      </div>
      <div
        style={{
          fontSize: 12,
          letterSpacing: 6,
          color: "#d4af37",
          textTransform: "uppercase",
          marginTop: 4,
          fontWeight: 500
        }}
      >
        Commercial Real Estate · The RE Twitter Edition
      </div>
      <div
        style={{
          marginTop: 20,
          background: "rgba(212,175,55,0.06)",
          border: "1px solid rgba(212,175,55,0.3)",
          borderRadius: 10,
          padding: "12px 16px",
          fontSize: 11,
          maxWidth: 480,
          textAlign: "center"
        }}
      >
        <div style={{ color: "#d4af37", fontWeight: 700, fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 6 }}>
          Building Tiers
        </div>
        <div style={{ fontSize: 11, color: "#cfd6ea" }}>
          Restaurant → Industrial → Multifamily → Retail → Office
        </div>
        <div style={{ marginTop: 10, color: "#d4af37", fontWeight: 700, fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase" }}>
          Air Rights replace Railroads
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="board-wrap"
      style={{
        display: "grid",
        gridTemplateColumns: "120px repeat(9, 80px) 120px",
        gridTemplateRows: "120px repeat(9, 80px) 120px",
        gap: 2,
        background: "#d4af37",
        padding: 2,
        borderRadius: 12,
        boxShadow: "0 30px 80px rgba(0,0,0,0.6), 0 0 0 4px #1a2245"
      }}
    >
      {cells}
    </div>
  );
}
