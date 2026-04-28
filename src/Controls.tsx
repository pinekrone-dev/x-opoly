import React from "react";
import { GameState, activePlayer, canBuild, canMortgage, canSell, canUnmortgage, priceOf } from "./game";
import { BOARD, PropertySpace } from "./boardData";

interface Props {
  state: GameState;
  onRoll: () => void;
  onBuy: () => void;
  onDecline: () => void;
  onApplyCard: () => void;
  onEndTurn: () => void;
  onPayJail: () => void;
  onUseFree: () => void;
  onRestart: () => void;
  onOpenManage: () => void;
}

export default function Controls(props: Props) {
  const { state, onRoll, onBuy, onDecline, onApplyCard, onEndTurn, onPayJail, onUseFree, onRestart, onOpenManage } = props;
  const player = activePlayer(state);
  const dice = state.dice;
  const isHumanTurn = !player.isAI && !player.bankrupt && state.phase !== "gameOver";

  return (
    <div className="panel" style={{ width: 260, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "#d4af37", fontWeight: 800, letterSpacing: 1, fontSize: 12, textTransform: "uppercase" }}>
        Turn: {player.name}
        {player.isAI ? " (AI thinking…)" : ""}
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <div className="dice-face">{dice ? dice[0] : "·"}</div>
        <div className="dice-face">{dice ? dice[1] : "·"}</div>
      </div>
      {state.winner !== null && (
        <div style={{ color: "#d4af37", fontWeight: 800, textAlign: "center", padding: 10 }}>
          Winner: {state.players[state.winner].name}
        </div>
      )}
      {isHumanTurn && (
        <>
          {player.inJail && (
            <div style={{ background: "rgba(255,255,255,0.05)", padding: 8, borderRadius: 8, fontSize: 11 }}>
              <div style={{ marginBottom: 6 }}>You are in OFAC Hold (turn {player.jailTurns + 1}/3).</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn-ghost" onClick={onPayJail} disabled={player.cash < 50}>
                  Pay $50
                </button>
                <button className="btn-ghost" onClick={onUseFree} disabled={player.getOutFreeCards <= 0}>
                  Use Free
                </button>
              </div>
            </div>
          )}
          {state.phase === "awaitRoll" && (
            <button className="btn-gold" onClick={onRoll}>
              Roll Dice
            </button>
          )}
          {state.phase === "awaitDecision" && state.pendingPurchase !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12 }}>
                Buy <b>{BOARD[state.pendingPurchase].name}</b> for ${priceOf(state.pendingPurchase)}?
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn-gold" onClick={onBuy} disabled={player.cash < priceOf(state.pendingPurchase)}>
                  Buy
                </button>
                <button className="btn-ghost" onClick={onDecline}>
                  Decline
                </button>
              </div>
            </div>
          )}
          {state.phase === "awaitCard" && state.pendingCard && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  background: state.pendingCard.deck === "crei" ? "linear-gradient(135deg, #fff8e1 0%, #ffe9a8 100%)" : "linear-gradient(135deg, #f3e5f5 0%, #d6b3e0 100%)",
                  color: "#111",
                  padding: 12,
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 12,
                  textAlign: "center"
                }}
              >
                <div style={{ color: "#7c5a00", fontSize: 10, fontWeight: 800, letterSpacing: 2, marginBottom: 4 }}>
                  {state.pendingCard.deck === "crei" ? "CREi SUMMIT" : "RE GALA"}
                </div>
                {state.pendingCard.card.text}
              </div>
              <button className="btn-gold" onClick={onApplyCard}>
                Apply Card
              </button>
            </div>
          )}
          {state.phase === "endTurn" && (
            <button className="btn-gold" onClick={onEndTurn}>
              End Turn
            </button>
          )}
          <button className="btn-ghost" onClick={onOpenManage}>
            Manage Properties
          </button>
        </>
      )}
      <div style={{ marginTop: 6 }}>
        <button className="btn-ghost" style={{ width: "100%" }} onClick={onRestart}>
          Restart Game
        </button>
      </div>
    </div>
  );
}
