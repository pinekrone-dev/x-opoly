import React from "react";
import { GameState, netWorth, ownsFullGroup } from "./game";
import { BOARD, COLOR_GROUPS, ColorGroup, PropertySpace } from "./boardData";

interface Props {
  state: GameState;
}

const colorHex: Record<ColorGroup, string> = {
  brown: "#8B4513",
  lblue: "#AAE0FA",
  pink: "#D93A96",
  orange: "#F7941D",
  red: "#ED1B24",
  yellow: "#FEF200",
  green: "#1FB25A",
  dblue: "#0072BB"
};

export default function Sidebar({ state }: Props) {
  return (
    <div className="panel" style={{ width: 260, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "#d4af37", fontWeight: 800, letterSpacing: 1, fontSize: 12, textTransform: "uppercase" }}>
        Players
      </div>
      {state.players.map((p) => {
        const owned = Object.entries(state.properties)
          .filter(([_, ps]) => ps.ownerId === p.id)
          .map(([id]) => Number(id));
        const isCurrent = state.currentTurn === p.id && !state.players[p.id].bankrupt;
        return (
          <div
            key={p.id}
            style={{
              border: `1px solid ${isCurrent ? "#d4af37" : "rgba(212,175,55,0.2)"}`,
              background: isCurrent ? "rgba(212,175,55,0.08)" : "rgba(15,27,58,0.5)",
              borderRadius: 10,
              padding: 8,
              opacity: p.bankrupt ? 0.4 : 1
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="token-pip" style={{ background: p.color }} />
                <span style={{ fontWeight: 800, fontSize: 13 }}>{p.name}</span>
                {p.isAI && (
                  <span style={{ fontSize: 9, color: "#d4af37", border: "1px solid #d4af37", padding: "0 4px", borderRadius: 4 }}>AI</span>
                )}
              </div>
              <div style={{ fontWeight: 800, color: "#d4af37" }}>${p.cash}</div>
            </div>
            <div style={{ fontSize: 10, color: "#aab4cf", marginTop: 4 }}>
              Net: ${netWorth(state, p.id)} · Pos: {BOARD[p.position].name}
              {p.inJail ? " (HOLD)" : ""}
              {p.getOutFreeCards > 0 ? ` · ${p.getOutFreeCards}× free` : ""}
            </div>
            {owned.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 6 }}>
                {owned.map((id) => {
                  const sp = BOARD[id];
                  let bg = "#888";
                  if (sp.kind === "property") bg = colorHex[(sp as PropertySpace).group];
                  else if (sp.kind === "air") bg = "#1a2245";
                  else if (sp.kind === "utility") bg = "#fde68a";
                  const ps = state.properties[id];
                  return (
                    <span
                      key={id}
                      title={`${sp.name}${ps.mortgaged ? " (mortgaged)" : ""}${ps.buildings ? ` T${ps.buildings}` : ""}`}
                      style={{
                        background: bg,
                        color: bg === "#fde68a" || bg === "#FEF200" ? "#111" : "#fff",
                        fontSize: 8.5,
                        fontWeight: 700,
                        padding: "1px 4px",
                        borderRadius: 3,
                        opacity: ps.mortgaged ? 0.45 : 1
                      }}
                    >
                      {sp.name.slice(0, 14)}
                      {ps.buildings ? ` ·T${ps.buildings}` : ""}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
