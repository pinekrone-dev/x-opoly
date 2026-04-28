import React, { useEffect, useRef, useState } from "react";
import Board from "./Board";
import Sidebar from "./Sidebar";
import Controls from "./Controls";
import Manage from "./Manage";
import { GameState, activePlayer, initState } from "./game";
import { TokenIcon, TOKEN_NAMES, TOKEN_COUNT } from "./tokens";
import {
  rollAndMove,
  buyCurrent,
  declineCurrent,
  applyPendingCard,
  endTurn,
  buildOn,
  sellOn,
  mortgage,
  unmortgage,
  payJailFee,
  useGetOutFree,
  aiTakeTurn
} from "./engine";

export default function App() {
  const [numAI, setNumAI] = useState<number>(1);
  const [playerToken, setPlayerToken] = useState<number>(0);
  const [state, setState] = useState<GameState>(() => initState(1, "You", 0));
  const [manageOpen, setManageOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState<boolean>(true);
  const aiTimer = useRef<number | null>(null);

  // AI auto-play
  useEffect(() => {
    if (setupOpen) return;
    if (state.phase === "gameOver") return;
    const p = activePlayer(state);
    if (!p.isAI || p.bankrupt) return;
    if (aiTimer.current) window.clearTimeout(aiTimer.current);
    aiTimer.current = window.setTimeout(() => {
      const next = aiTakeTurn(state);
      if (next.phase === "endTurn") {
        setState(endTurn(next));
      } else {
        setState(next);
      }
    }, 800);
    return () => {
      if (aiTimer.current) window.clearTimeout(aiTimer.current);
    };
  }, [state, setupOpen]);

  function handleRoll() { setState(rollAndMove(state)); }
  function handleBuy() { setState(buyCurrent(state)); }
  function handleDecline() { setState(declineCurrent(state)); }
  function handleApplyCard() { setState(applyPendingCard(state)); }
  function handleEndTurn() { setState(endTurn(state)); }
  function handlePayJail() { setState(payJailFee(state)); }
  function handleUseFree() { setState(useGetOutFree(state)); }
  function handleBuild(id: number) { setState(buildOn(state, id)); }
  function handleSell(id: number) { setState(sellOn(state, id)); }
  function handleMortgage(id: number) { setState(mortgage(state, id)); }
  function handleUnmortgage(id: number) { setState(unmortgage(state, id)); }
  function handleRestart() {
    setSetupOpen(true);
    setManageOpen(false);
  }

  if (setupOpen) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
        <div className="panel" style={{ width: 540, padding: 28 }}>
          <div className="gold-text serif" style={{ fontSize: 64, fontWeight: 900, letterSpacing: -2, lineHeight: 1, textAlign: "center" }}>
            X-OPOLY
          </div>
          <div style={{ textAlign: "center", color: "#d4af37", letterSpacing: 4, fontSize: 11, textTransform: "uppercase", marginTop: 6, marginBottom: 22, fontFamily: "'Playfair Display', Georgia, serif" }}>
            The Real Estate Game of Strategy, Connections &amp; Capital
          </div>
          <div style={{ fontSize: 13, color: "#cfd6ea", marginBottom: 12, textAlign: "center", fontFamily: "'Playfair Display', Georgia, serif", letterSpacing: 1 }}>
            Choose your token
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 22 }}>
            {Array.from({ length: TOKEN_COUNT }).map((_, i) => (
              <button
                key={i}
                onClick={() => setPlayerToken(i)}
                style={{
                  background: i === playerToken ? "rgba(212,175,55,0.18)" : "rgba(15,21,37,0.6)",
                  border: i === playerToken ? "2px solid #d4af37" : "1px solid rgba(212,175,55,0.3)",
                  borderRadius: 10,
                  padding: 10,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  transition: "transform 0.12s ease"
                }}
              >
                <TokenIcon idx={i} size={42} />
                <span style={{ fontSize: 9, color: "#d4af37", letterSpacing: 0.5, textTransform: "uppercase", fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 700 }}>
                  {TOKEN_NAMES[i]}
                </span>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 13, color: "#cfd6ea", marginBottom: 10, textAlign: "center", fontFamily: "'Playfair Display', Georgia, serif", letterSpacing: 1 }}>
            How many AI opponents?
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 22 }}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={n === numAI ? "btn-gold" : "btn-ghost"}
                onClick={() => setNumAI(n)}
                style={{ minWidth: 72 }}
              >
                {n} AI
              </button>
            ))}
          </div>
          <button
            className="btn-gold"
            style={{ width: "100%", padding: 14, fontSize: 14 }}
            onClick={() => {
              setState(initState(numAI, "You", playerToken));
              setSetupOpen(false);
            }}
          >
            Start Game
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", padding: 16 }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <span
          className="gold-text serif"
          style={{
            fontSize: 36,
            fontWeight: 900,
            letterSpacing: 2
          }}
        >
          X-OPOLY
        </span>
        <div style={{ color: "#aab4cf", fontSize: 12, marginTop: 2, fontFamily: "'Playfair Display', Georgia, serif", letterSpacing: 1, textTransform: "uppercase" }}>
          The Real Estate Game of Strategy, Connections &amp; Capital
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
        <Sidebar state={state} />
        <div>
          <Board state={state} onTileClick={() => setManageOpen(true)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Controls
            state={state}
            onRoll={handleRoll}
            onBuy={handleBuy}
            onDecline={handleDecline}
            onApplyCard={handleApplyCard}
            onEndTurn={handleEndTurn}
            onPayJail={handlePayJail}
            onUseFree={handleUseFree}
            onRestart={handleRestart}
            onOpenManage={() => setManageOpen(true)}
          />
          <div className="panel scroll-y" style={{ width: 260, height: 260 }}>
            <div style={{ color: "#d4af37", fontWeight: 800, letterSpacing: 1, fontSize: 12, textTransform: "uppercase", marginBottom: 6, fontFamily: "'Playfair Display', Georgia, serif" }}>
              Activity
            </div>
            {state.log.slice(-40).reverse().map((l, i) => (
              <div className="log-entry" key={i}>{l}</div>
            ))}
          </div>
        </div>
      </div>
      <Manage
        state={state}
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onBuild={handleBuild}
        onSell={handleSell}
        onMortgage={handleMortgage}
        onUnmortgage={handleUnmortgage}
      />
    </div>
  );
}
