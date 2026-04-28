import React from "react";
import { GameState, activePlayer, canBuild, canMortgage, canSell, canUnmortgage, unmortgageCost } from "./game";
import { BOARD, COLOR_GROUPS, ColorGroup, PropertySpace } from "./boardData";

interface Props {
  state: GameState;
  open: boolean;
  onClose: () => void;
  onBuild: (id: number) => void;
  onSell: (id: number) => void;
  onMortgage: (id: number) => void;
  onUnmortgage: (id: number) => void;
}

const GROUP_LABEL: Record<ColorGroup, string> = {
  brown: "Brown",
  lblue: "Light Blue",
  pink: "Pink",
  orange: "Orange",
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  dblue: "Dark Blue"
};

export default function Manage({ state, open, onClose, onBuild, onSell, onMortgage, onUnmortgage }: Props) {
  if (!open) return null;
  const player = activePlayer(state);
  const owned = Object.entries(state.properties)
    .filter(([_, ps]) => ps.ownerId === player.id)
    .map(([id]) => Number(id));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3,5,15,0.7)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ width: 560, maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ color: "#d4af37", fontWeight: 800, fontSize: 14, letterSpacing: 1, textTransform: "uppercase" }}>
            Manage · {player.name}
          </div>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {owned.length === 0 && <div style={{ color: "#aab4cf", fontSize: 12 }}>No properties yet.</div>}
        {owned.map((id) => {
          const sp = BOARD[id];
          const ps = state.properties[id];
          const isProp = sp.kind === "property";
          const p = sp as PropertySpace;
          return (
            <div key={id} style={{ borderBottom: "1px solid rgba(212,175,55,0.15)", padding: "8px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{sp.name}</div>
                  <div style={{ fontSize: 10, color: "#aab4cf" }}>
                    {isProp ? `${GROUP_LABEL[p.group]} · Tier ${ps.buildings}/5` : sp.kind.toUpperCase()}
                    {ps.mortgaged ? " · MORTGAGED" : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {isProp && (
                    <button
                      className="btn-ghost"
                      disabled={!canBuild(state, player.id, id)}
                      onClick={() => onBuild(id)}
                      title={`Build for $${p.buildCost}`}
                    >
                      Build (+1)
                    </button>
                  )}
                  {isProp && (
                    <button
                      className="btn-ghost"
                      disabled={!canSell(state, player.id, id)}
                      onClick={() => onSell(id)}
                    >
                      Sell tier
                    </button>
                  )}
                  {!ps.mortgaged ? (
                    <button
                      className="btn-ghost"
                      disabled={!canMortgage(state, player.id, id)}
                      onClick={() => onMortgage(id)}
                    >
                      Mortgage
                    </button>
                  ) : (
                    <button
                      className="btn-ghost"
                      disabled={!canUnmortgage(state, player.id, id)}
                      onClick={() => onUnmortgage(id)}
                      title={`Pay $${unmortgageCost(id)}`}
                    >
                      Unmortgage
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
