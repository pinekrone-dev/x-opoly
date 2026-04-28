import {
  GameState,
  GamePhase,
  Player,
  GO_REWARD,
  JAIL_INDEX,
  GO_TO_JAIL_INDEX,
  rentFor,
  rollDice,
  activePlayer,
  airRightsOwned,
  utilitiesOwned,
  ownsFullGroup,
  canBuild,
  canSell,
  canMortgage,
  canUnmortgage,
  unmortgageCost,
  priceOf,
  mortgageOf,
  isOwnable,
  netWorth,
  nameOf,
  STARTING_CASH
} from "./game";
import { BOARD, PropertySpace, Space, spaceAt, AIR_INDICES, UTILITY_INDICES } from "./boardData";
import { Card, shuffle, CREI_SUMMIT_CARDS, RE_GALA_CARDS } from "./cards";

function clone(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({ ...p })),
    dice: state.dice ? ([state.dice[0], state.dice[1]] as [number, number]) : null,
    properties: Object.fromEntries(
      Object.entries(state.properties).map(([k, v]) => [k, { ...v }])
    ),
    creiDeck: state.creiDeck.slice(),
    creiDiscard: state.creiDiscard.slice(),
    galaDeck: state.galaDeck.slice(),
    galaDiscard: state.galaDiscard.slice(),
    log: state.log.slice()
  };
}

function pushLog(state: GameState, line: string): void {
  state.log.push(line);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function transferCash(state: GameState, fromId: number | null, toId: number | null, amount: number): void {
  if (amount <= 0) return;
  if (fromId !== null) state.players[fromId].cash -= amount;
  if (toId !== null) state.players[toId].cash += amount;
}

function checkBankruptcy(state: GameState, playerId: number): void {
  const p = state.players[playerId];
  if (p.bankrupt) return;
  if (p.cash < 0) {
    // try to liquidate by mortgaging unmortgaged props
    for (const idStr of Object.keys(state.properties)) {
      const id = Number(idStr);
      const ps = state.properties[id];
      if (ps.ownerId === playerId && !ps.mortgaged) {
        const sp = BOARD[id];
        if (sp.kind === "property" && (sp as PropertySpace).price > 0) {
          // cannot mortgage if buildings on group; sell buildings first
          // Sell down all buildings in group
          const grp = (sp as PropertySpace).group;
          const groupIds = (BOARD.filter(
            (s) => s.kind === "property" && (s as PropertySpace).group === grp
          ) as PropertySpace[]).map((s) => s.id);
          for (const gid of groupIds) {
            const gps = state.properties[gid];
            if (gps.ownerId === playerId && gps.buildings > 0) {
              const gsp = BOARD[gid] as PropertySpace;
              p.cash += Math.floor(gsp.buildCost / 2) * gps.buildings;
              gps.buildings = 0;
            }
          }
        }
        ps.mortgaged = true;
        p.cash += mortgageOf(id);
        if (p.cash >= 0) break;
      }
    }
  }
  if (p.cash < 0) {
    // bankrupt
    p.bankrupt = true;
    pushLog(state, `${p.name} is bankrupt.`);
    // release properties to bank (simple v1)
    for (const idStr of Object.keys(state.properties)) {
      const id = Number(idStr);
      const ps = state.properties[id];
      if (ps.ownerId === playerId) {
        ps.ownerId = null;
        ps.buildings = 0;
        ps.mortgaged = false;
      }
    }
  }
}

function checkWin(state: GameState): void {
  const live = state.players.filter((p) => !p.bankrupt);
  if (live.length === 1 && state.players.length > 1) {
    state.winner = live[0].id;
    state.phase = "gameOver";
    pushLog(state, `${live[0].name} wins X-opoly.`);
  }
}

function drawCard(state: GameState, deck: "crei" | "gala"): Card {
  if (deck === "crei") {
    if (state.creiDeck.length === 0) {
      state.creiDeck = shuffle(state.creiDiscard);
      state.creiDiscard = [];
    }
    const card = state.creiDeck.shift() as Card;
    return card;
  } else {
    if (state.galaDeck.length === 0) {
      state.galaDeck = shuffle(state.galaDiscard);
      state.galaDiscard = [];
    }
    const card = state.galaDeck.shift() as Card;
    return card;
  }
}

function discardCard(state: GameState, deck: "crei" | "gala", card: Card): void {
  if (deck === "crei") state.creiDiscard.push(card);
  else state.galaDiscard.push(card);
}

function landOn(state: GameState, playerId: number, diceTotal: number, withinCardEffect = false): void {
  const player = state.players[playerId];
  const space = BOARD[player.position];
  pushLog(state, `${player.name} landed on ${space.name}.`);
  if (space.kind === "go") {
    // only triggers when actually landing exactly; pass-by handled separately
    return;
  }
  if (space.kind === "tax") {
    const amt = (space as { amount?: number }).amount || 0;
    pushLog(state, `${player.name} pays ${amt} (${space.name}).`);
    transferCash(state, playerId, null, amt);
    checkBankruptcy(state, playerId);
    return;
  }
  if (space.kind === "gotojail") {
    pushLog(state, `${player.name} hit DSCR Failed. Off to OFAC Hold.`);
    sendToJail(state, playerId);
    return;
  }
  if (space.kind === "parking") {
    pushLog(state, `${player.name} pauses for the 1031 Identification Window.`);
    return;
  }
  if (space.kind === "jail") {
    // just visiting (not actually in jail)
    return;
  }
  if (space.kind === "crei" || space.kind === "gala") {
    const deck = space.kind === "crei" ? "crei" : "gala";
    const card = drawCard(state, deck);
    state.pendingCard = { deck, card };
    pushLog(state, `${player.name} draws: ${card.text}`);
    state.phase = "awaitCard";
    return;
  }
  // ownable
  if (isOwnable(space)) {
    const ps = state.properties[player.position];
    if (ps.ownerId === null) {
      // unowned: prompt buy
      state.pendingPurchase = player.position;
      state.phase = "awaitDecision";
      return;
    }
    if (ps.ownerId === playerId) {
      pushLog(state, `${player.name} owns this. No rent.`);
      return;
    }
    if (ps.mortgaged) {
      pushLog(state, `${BOARD[player.position].name} is mortgaged. No rent.`);
      return;
    }
    const rent = rentFor(state, player.position, diceTotal);
    if (rent > 0) {
      pushLog(state, `${player.name} pays $${rent} rent to ${state.players[ps.ownerId].name}.`);
      transferCash(state, playerId, ps.ownerId, rent);
      checkBankruptcy(state, playerId);
    }
  }
}

export function sendToJail(state: GameState, playerId: number): void {
  const p = state.players[playerId];
  p.position = JAIL_INDEX;
  p.inJail = true;
  p.jailTurns = 0;
  state.doublesCount = 0;
  state.phase = "endTurn";
}

export function rollAndMove(state: GameState): GameState {
  const s = clone(state);
  if (s.phase !== "awaitRoll") return s;
  const player = activePlayer(s);
  if (player.bankrupt) {
    s.phase = "endTurn";
    return s;
  }
  const dice = rollDice();
  s.dice = dice;
  const total = dice[0] + dice[1];
  const isDoubles = dice[0] === dice[1];
  pushLog(s, `${player.name} rolls ${dice[0]} + ${dice[1]} = ${total}${isDoubles ? " (doubles)" : ""}.`);

  if (player.inJail) {
    if (isDoubles) {
      pushLog(s, `${player.name} rolls doubles and leaves OFAC Hold.`);
      player.inJail = false;
      player.jailTurns = 0;
      // don't roll again on doubles out of jail
      movePlayer(s, player.id, total, false);
      const post = activePlayer(s);
      if ((s.phase as GamePhase) !== "awaitDecision" && (s.phase as GamePhase) !== "awaitCard" && (s.phase as GamePhase) !== "gameOver") {
        s.phase = "endTurn";
      }
      return s;
    } else {
      player.jailTurns += 1;
      if (player.jailTurns >= 3) {
        // forced to pay
        if (player.cash >= 50) {
          player.cash -= 50;
          pushLog(s, `${player.name} pays $50 OFAC fee on third turn.`);
          player.inJail = false;
          player.jailTurns = 0;
          movePlayer(s, player.id, total, false);
        } else {
          pushLog(s, `${player.name} cannot pay OFAC fee.`);
          checkBankruptcy(s, player.id);
        }
      } else {
        pushLog(s, `${player.name} stays in OFAC Hold.`);
      }
      if ((s.phase as GamePhase) !== "awaitDecision" && (s.phase as GamePhase) !== "awaitCard" && (s.phase as GamePhase) !== "gameOver") {
        s.phase = "endTurn";
      }
      return s;
    }
  }

  if (isDoubles) {
    s.doublesCount += 1;
    if (s.doublesCount === 3) {
      pushLog(s, `${player.name} rolls three doubles in a row. Off to OFAC Hold.`);
      sendToJail(s, player.id);
      return s;
    }
  } else {
    s.doublesCount = 0;
  }

  movePlayer(s, player.id, total, true);
  if ((s.phase as GamePhase) !== "awaitDecision" && (s.phase as GamePhase) !== "awaitCard" && (s.phase as GamePhase) !== "gameOver") {
    s.phase = isDoubles && !player.inJail ? "awaitRoll" : "endTurn";
  }
  return s;
}

function movePlayer(state: GameState, playerId: number, steps: number, awardForPass: boolean): void {
  const p = state.players[playerId];
  const newPos = (p.position + steps) % 40;
  if (awardForPass && newPos < p.position) {
    p.cash += GO_REWARD;
    pushLog(state, `${p.name} passes Closing Day. +$${GO_REWARD}.`);
  } else if (awardForPass && p.position + steps >= 40) {
    p.cash += GO_REWARD;
    pushLog(state, `${p.name} passes Closing Day. +$${GO_REWARD}.`);
  }
  p.position = newPos;
  if (p.position === 0 && awardForPass === false && steps > 0) {
    // landed on go after card moveTo with collectIfPass false but landing exact gets nothing extra
  }
  state.dice = state.dice;
  landOn(state, playerId, steps);
}

export function buyCurrent(state: GameState): GameState {
  const s = clone(state);
  if (s.phase !== "awaitDecision" || s.pendingPurchase === null) return s;
  const player = activePlayer(s);
  const id = s.pendingPurchase;
  const price = priceOf(id);
  if (player.cash < price) {
    pushLog(s, `${player.name} cannot afford ${nameOf(id)}.`);
    s.pendingPurchase = null;
    s.phase = "endTurn";
    return s;
  }
  player.cash -= price;
  s.properties[id].ownerId = player.id;
  pushLog(s, `${player.name} bought ${nameOf(id)} for $${price}.`);
  s.pendingPurchase = null;
  s.phase = "endTurn";
  return s;
}

export function declineCurrent(state: GameState): GameState {
  const s = clone(state);
  if (s.phase !== "awaitDecision" || s.pendingPurchase === null) return s;
  const player = activePlayer(s);
  pushLog(s, `${player.name} declined ${nameOf(s.pendingPurchase)}.`);
  s.pendingPurchase = null;
  s.phase = "endTurn";
  return s;
}

export function applyPendingCard(state: GameState): GameState {
  const s = clone(state);
  if (s.phase !== "awaitCard" || !s.pendingCard) return s;
  const { deck, card } = s.pendingCard;
  const player = activePlayer(s);
  const eff = card.effect;
  switch (eff.type) {
    case "collect":
      player.cash += eff.amount || 0;
      pushLog(s, `${player.name} collects $${eff.amount}.`);
      break;
    case "pay":
      player.cash -= eff.amount || 0;
      pushLog(s, `${player.name} pays $${eff.amount}.`);
      checkBankruptcy(s, player.id);
      break;
    case "moveTo": {
      const target = eff.target ?? 0;
      const passes = target < player.position;
      if (eff.collectIfPass && passes) {
        player.cash += GO_REWARD;
        pushLog(s, `${player.name} passes Closing Day. +$${GO_REWARD}.`);
      }
      player.position = target;
      pushLog(s, `${player.name} advances to ${nameOf(target)}.`);
      // discard before landing so card draws don't double-pop
      discardCard(s, deck, card);
      s.pendingCard = null;
      // re-land on new space
      landOnAfterCard(s, player.id);
      return s;
    }
    case "moveBy": {
      const steps = eff.steps || 0;
      player.position = ((player.position + steps) % 40 + 40) % 40;
      pushLog(s, `${player.name} moves ${steps} to ${nameOf(player.position)}.`);
      discardCard(s, deck, card);
      s.pendingCard = null;
      landOnAfterCard(s, player.id);
      return s;
    }
    case "goToJail":
      sendToJail(s, player.id);
      pushLog(s, `${player.name} sent to OFAC Hold.`);
      break;
    case "getOutFree":
      player.getOutFreeCards += 1;
      pushLog(s, `${player.name} keeps a Get Out of OFAC Hold Free card.`);
      break;
    case "collectFromEach": {
      const amt = eff.amount || 0;
      for (const other of s.players) {
        if (other.id === player.id || other.bankrupt) continue;
        const take = Math.min(amt, other.cash);
        other.cash -= amt;
        player.cash += amt;
        checkBankruptcy(s, other.id);
      }
      pushLog(s, `${player.name} collects $${amt} from each opponent.`);
      break;
    }
    case "payEach": {
      const amt = eff.amount || 0;
      for (const other of s.players) {
        if (other.id === player.id || other.bankrupt) continue;
        player.cash -= amt;
        other.cash += amt;
      }
      pushLog(s, `${player.name} pays $${amt} to each opponent.`);
      checkBankruptcy(s, player.id);
      break;
    }
    case "payPerProperty": {
      const per = eff.perProperty || 0;
      const owned = Object.values(s.properties).filter((ps) => ps.ownerId === player.id).length;
      const total = per * owned;
      player.cash -= total;
      pushLog(s, `${player.name} pays $${total} (${owned} properties × $${per}).`);
      checkBankruptcy(s, player.id);
      break;
    }
  }
  discardCard(s, deck, card);
  s.pendingCard = null;
  if ((s.phase as GamePhase) !== "gameOver") s.phase = "endTurn";
  checkWin(s);
  return s;
}

function landOnAfterCard(state: GameState, playerId: number): void {
  const p = state.players[playerId];
  const sp = BOARD[p.position];
  if (sp.kind === "go") {
    state.phase = "endTurn";
    return;
  }
  if (sp.kind === "tax") {
    const amt = (sp as { amount?: number }).amount || 0;
    pushLog(state, `${p.name} pays ${amt} (${sp.name}).`);
    state.players[playerId].cash -= amt;
    checkBankruptcy(state, playerId);
    state.phase = "endTurn";
    return;
  }
  if (sp.kind === "gotojail") {
    sendToJail(state, playerId);
    return;
  }
  if (sp.kind === "parking" || sp.kind === "jail") {
    state.phase = "endTurn";
    return;
  }
  if (sp.kind === "crei" || sp.kind === "gala") {
    const deck = sp.kind === "crei" ? "crei" : "gala";
    const card = drawCard(state, deck);
    state.pendingCard = { deck, card };
    pushLog(state, `${p.name} draws: ${card.text}`);
    state.phase = "awaitCard";
    return;
  }
  if (isOwnable(sp)) {
    const ps = state.properties[p.position];
    if (ps.ownerId === null) {
      state.pendingPurchase = p.position;
      state.phase = "awaitDecision";
      return;
    }
    if (ps.ownerId === playerId) {
      pushLog(state, `${p.name} owns this.`);
      state.phase = "endTurn";
      return;
    }
    if (!ps.mortgaged) {
      const total = (state.dice ? state.dice[0] + state.dice[1] : 0) || 7;
      const rent = rentFor(state, p.position, total);
      if (rent > 0) {
        pushLog(state, `${p.name} pays $${rent} rent to ${state.players[ps.ownerId].name}.`);
        state.players[playerId].cash -= rent;
        state.players[ps.ownerId].cash += rent;
        checkBankruptcy(state, playerId);
      }
    }
    state.phase = "endTurn";
  }
}

export function endTurn(state: GameState): GameState {
  const s = clone(state);
  if (s.phase === "gameOver") return s;
  // skip bankrupt players
  let next = s.currentTurn;
  for (let i = 0; i < s.players.length; i++) {
    next = (next + 1) % s.players.length;
    if (!s.players[next].bankrupt) break;
  }
  s.currentTurn = next;
  s.dice = null;
  s.doublesCount = 0;
  s.phase = "awaitRoll";
  checkWin(s);
  return s;
}

export function buildOn(state: GameState, spaceId: number): GameState {
  const s = clone(state);
  const p = activePlayer(s);
  if (!canBuild(s, p.id, spaceId)) return s;
  const sp = BOARD[spaceId] as PropertySpace;
  s.players[p.id].cash -= sp.buildCost;
  s.properties[spaceId].buildings += 1;
  pushLog(s, `${p.name} builds on ${sp.name}. (Tier ${s.properties[spaceId].buildings})`);
  return s;
}

export function sellOn(state: GameState, spaceId: number): GameState {
  const s = clone(state);
  const p = activePlayer(s);
  if (!canSell(s, p.id, spaceId)) return s;
  const sp = BOARD[spaceId] as PropertySpace;
  s.players[p.id].cash += Math.floor(sp.buildCost / 2);
  s.properties[spaceId].buildings -= 1;
  pushLog(s, `${p.name} sells a tier on ${sp.name}.`);
  return s;
}

export function mortgage(state: GameState, spaceId: number): GameState {
  const s = clone(state);
  const p = activePlayer(s);
  if (!canMortgage(s, p.id, spaceId)) return s;
  s.players[p.id].cash += mortgageOf(spaceId);
  s.properties[spaceId].mortgaged = true;
  pushLog(s, `${p.name} mortgaged ${nameOf(spaceId)}.`);
  return s;
}

export function unmortgage(state: GameState, spaceId: number): GameState {
  const s = clone(state);
  const p = activePlayer(s);
  if (!canUnmortgage(s, p.id, spaceId)) return s;
  s.players[p.id].cash -= unmortgageCost(spaceId);
  s.properties[spaceId].mortgaged = false;
  pushLog(s, `${p.name} unmortgaged ${nameOf(spaceId)}.`);
  return s;
}

export function payJailFee(state: GameState): GameState {
  const s = clone(state);
  const p = activePlayer(s);
  if (!p.inJail) return s;
  if (p.cash < 50) return s;
  p.cash -= 50;
  p.inJail = false;
  p.jailTurns = 0;
  pushLog(s, `${p.name} pays $50 OFAC fee.`);
  return s;
}

export function useGetOutFree(state: GameState): GameState {
  const s = clone(state);
  const p = activePlayer(s);
  if (!p.inJail || p.getOutFreeCards <= 0) return s;
  p.getOutFreeCards -= 1;
  p.inJail = false;
  p.jailTurns = 0;
  pushLog(s, `${p.name} plays Get Out of OFAC Hold Free.`);
  return s;
}

// AI: greedy
export function aiTakeTurn(state: GameState): GameState {
  let s = state;
  const p = activePlayer(s);
  if (!p.isAI || p.bankrupt) return s;

  if (p.inJail) {
    if (p.getOutFreeCards > 0) s = useGetOutFree(s);
    else if (p.cash > 200 && p.jailTurns < 2) s = payJailFee(s);
  }

  if (s.phase === "awaitRoll") {
    s = rollAndMove(s);
  }

  // handle pending decisions
  let safety = 0;
  while (safety++ < 20) {
    if (s.phase === "awaitDecision" && s.pendingPurchase !== null) {
      const id = s.pendingPurchase;
      const cost = priceOf(id);
      const cur = activePlayer(s);
      if (cur.cash > cost + 200) s = buyCurrent(s);
      else s = declineCurrent(s);
    } else if (s.phase === "awaitCard") {
      s = applyPendingCard(s);
    } else {
      break;
    }
  }

  // simple greedy build: build wherever possible while keeping $300 reserve
  let built = true;
  while (built) {
    built = false;
    const cur = activePlayer(s);
    for (const ps of BOARD) {
      if (ps.kind !== "property") continue;
      if (canBuild(s, cur.id, ps.id) && s.players[cur.id].cash > (ps as any).buildCost + 300) {
        s = buildOn(s, ps.id);
        built = true;
      }
    }
  }

  // after turn complete, if doubles allowed another roll, AI rolls again
  if (s.phase === "awaitRoll") {
    return aiTakeTurn(s);
  }

  return s;
}

export { clone, pushLog, checkBankruptcy };
