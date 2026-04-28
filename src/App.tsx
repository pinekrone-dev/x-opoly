import React, { useEffect, useRef, useState } from "react";
import Board from "./Board";
import Sidebar from "./Sidebar";
import Controls from "./Controls";
import Manage from "./Manage";
import { GameState, activePlayer, initState } from "./game";
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
  const [state, setState] = useState<GameState>(() => initState(1));
  const [manageOpen, setManageOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState<boolean>(true);
  const aiTimer = useRef<number | null>(null);

  // AI auto-play
  useEffect(() => {
    if (state.phase === "gameOver") return;
    const p = activePlayer(state);
    if (!p.isAI || p.bankrupt) return;
    if (aiTimer.current) window.clearTimeout(aiTimer.current);
    aiTimer.current = window.setTimeout(() => {
      const next = aiTakeTurn(state);
      // after AI completes, if still endTurn, advance
      if (next.phase === "endTurn") {
        setState(endTurn(next));
      } else {
        setState(next);
      }
    }, 800);
    return () => {
      if (aiTimer.current) window.clearTimeout(aiTimer.current);
    };
  }, [state]);

  function handleRoll() {
    setState(rollAndMove(state));
  }
  function handleBuy() {
    setState(buyCurrent(state));
  }
  function handleDecline() {
    setState(declineCurrent(state));
  }
  function handleApplyCard() {
    setState(applyPendingCard(state));
  }
  function handleEndTurn() {
    setState(endTurn(state));
  }
  function handlePayJail() {
    setState(payJailFee(state));
  }
  function handleUseFree() {
    setState(useGetOutFree(state));
  }
  function handleBuild(id: number) {
    setState(buildOn(state, id));
  }
  function handleSell(id: number) {
    setState(sellOn(state, id));
  }
  function handleMortgage(id: number) {
    setState(mortgage(state, id));
  }
  function handleUnmortgage(id: number) {
    setState(unmortgage(state, id));
  }
  function handleRestart() {
    setState(initState(numAI));
    setManageOpen(false);
  }

  if (setupOpen) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "center" }}>
        <div className="panel" style={{ width: 420, padding: 24 }}>
          <div className="gold-text" style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 56, fontWeight: 900, letterSpacing: -2, lineHeight: 1, textAlign: "center" }}>
            X-opoly
          </div>
          <div style={{ textAlign: "center", color: "#d4af37", letterSpacing: 4, fontSize: 11, textTransform: "uppercase", marginTop: 6, marginBottom: 18 }}>
            CRE · The RE Twitter Edition
          </div>
          <div style={{ fontSize: 13, color: "#cfd6ea", marginBottom: 14, textAlign: "center" }}>
            Single-player vs AI. Pick how many opponents.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 18 }}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={n === numAI ? "btn-gold" : "btn-ghost"}
                onClick={() => setNumAI(n)}
                style={{ minWidth: 60 }}
              >
                {n} AI
              </button>
            ))}
          </div>
          <button
            className="btn-gold"
            style={{ width: "100%", padding: 14, fontSize: 14 }}
            onClick={() => {
              setState(initState(numAI));
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
          className="gold-text"
          style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 36,
            fontWeight: 900,
            letterSpacing: 2
          }}
        >
          X-OPOLY
        </span>
        <div style={{ color: "#aab4cf", fontSize: 12, marginTop: 2 }}>
          A Commercial Real Estate twist on the classic.
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
            <div style={{ color: "#d4af37", fontWeight: 800, letterSpacing: 1, fontSize: 12, textTransform: "uppercase", marginBottom: 6 }}>
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
