import { BOARD, COLOR_GROUPS, PropertySpace, Space, spaceAt, AIR_INDICES, UTILITY_INDICES, ColorGroup, groupOf } from "./boardData";
import { Card, CREI_SUMMIT_CARDS, RE_GALA_CARDS, shuffle } from "./cards";

export const STARTING_CASH = 1500;
export const GO_REWARD = 200;
export const JAIL_FEE = 50;
export const JAIL_INDEX = 10;
export const GO_TO_JAIL_INDEX = 30;

export interface Player {
  id: number;
  name: string;
  isAI: boolean;
  color: string;
  cash: number;
  position: number;
  inJail: boolean;
  jailTurns: number;
  getOutFreeCards: number;
  bankrupt: boolean;
  tokenIdx: number;
}

export interface PropertyState {
  ownerId: number | null;
  buildings: number; // 0..5 for property color groups, 0/1 for air/util ownership flag (we'll use 0 = unowned counted, "owned" determined by ownerId)
  mortgaged: boolean;
}

export interface GameState {
  players: Player[];
  currentTurn: number; // index into players
  phase: GamePhase;
  dice: [number, number] | null;
  doublesCount: number;
  properties: Record<number, PropertyState>; // keyed by space id
  creiDeck: Card[];
  creiDiscard: Card[];
  galaDeck: Card[];
  galaDiscard: Card[];
  log: string[];
  pendingPurchase: number | null; // space id awaiting buy/decline decision
  pendingCard: { deck: "crei" | "gala"; card: Card } | null;
  winner: number | null;
}

export type GamePhase =
  | "awaitRoll"
  | "moving"
  | "awaitDecision" // buy or auction (we skip auction; buy or decline)
  | "awaitCard"
  | "endTurn"
  | "gameOver";

export const PLAYER_COLORS = ["#d4af37", "#FF7A45", "#1FB25A", "#0072BB"];

export function rollDie(): number {
  return 1 + Math.floor(Math.random() * 6);
}

export function rollDice(): [number, number] {
  return [rollDie(), rollDie()];
}

export function initState(numAI: number, playerName = "You", playerToken = 0): GameState {
  const total = Math.min(4, Math.max(2, 1 + numAI));
  const players: Player[] = [];
  players.push({
    id: 0,
    name: playerName,
    isAI: false,
    color: PLAYER_COLORS[0],
    cash: STARTING_CASH,
    position: 0,
    inJail: false,
    jailTurns: 0,
    getOutFreeCards: 0,
    bankrupt: false,
    tokenIdx: playerToken
  });
  const aiNames = ["StripMallGuy", "BeardyBrandon", "MosesKagan"];
  // assign distinct tokens for AI: pick from the pool excluding the human's chosen token
  const allTokens = [0, 1, 2, 3, 4, 5, 6, 7];
  const remaining = allTokens.filter((t) => t !== playerToken);
  for (let i = 1; i < total; i++) {
    players.push({
      id: i,
      name: aiNames[i - 1],
      isAI: true,
      color: PLAYER_COLORS[i],
      cash: STARTING_CASH,
      position: 0,
      inJail: false,
      jailTurns: 0,
      getOutFreeCards: 0,
      bankrupt: false,
      tokenIdx: remaining[i - 1] ?? i
    });
  }
  const properties: Record<number, PropertyState> = {};
  for (const s of BOARD) {
    if (s.kind === "property" || s.kind === "air" || s.kind === "utility") {
      properties[s.id] = { ownerId: null, buildings: 0, mortgaged: false };
    }
  }
  return {
    players,
    currentTurn: 0,
    phase: "awaitRoll",
    dice: null,
    doublesCount: 0,
    properties,
    creiDeck: shuffle(CREI_SUMMIT_CARDS),
    creiDiscard: [],
    galaDeck: shuffle(RE_GALA_CARDS),
    galaDiscard: [],
    log: ["Game ready. Click Roll to start."],
    pendingPurchase: null,
    pendingCard: null,
    winner: null
  };
}

export function activePlayer(state: GameState): Player {
  return state.players[state.currentTurn];
}

export function ownsFullGroup(state: GameState, playerId: number, group: ColorGroup): boolean {
  const ids = COLOR_GROUPS[group];
  return ids.every((id) => {
    const ps = state.properties[id];
    return ps.ownerId === playerId && !ps.mortgaged;
  });
}

export function airRightsOwned(state: GameState, playerId: number): number {
  return AIR_INDICES.filter(
    (id) => state.properties[id].ownerId === playerId && !state.properties[id].mortgaged
  ).length;
}

export function utilitiesOwned(state: GameState, playerId: number): number {
  return UTILITY_INDICES.filter(
    (id) => state.properties[id].ownerId === playerId && !state.properties[id].mortgaged
  ).length;
}

export function rentFor(state: GameState, spaceId: number, diceTotal: number): number {
  const space = BOARD[spaceId];
  const ps = state.properties[spaceId];
  if (!ps || ps.ownerId === null || ps.mortgaged) return 0;
  if (space.kind === "property") {
    const p = space as PropertySpace;
    let rent = p.baseRent;
    if (ps.buildings > 0) rent = p.rents[ps.buildings - 1];
    else if (ownsFullGroup(state, ps.ownerId, p.group)) rent = p.baseRent * 2;
    return rent;
  }
  if (space.kind === "air") {
    const owned = airRightsOwned(state, ps.ownerId);
    const table = [25, 50, 100, 200];
    return table[Math.max(0, owned - 1)] || 25;
  }
  if (space.kind === "utility") {
    const owned = utilitiesOwned(state, ps.ownerId);
    const mult = owned === 2 ? 10 : 4;
    return diceTotal * mult;
  }
  return 0;
}

export function netWorth(state: GameState, playerId: number): number {
  const player = state.players[playerId];
  let worth = player.cash;
  for (const idStr of Object.keys(state.properties)) {
    const id = Number(idStr);
    const ps = state.properties[id];
    if (ps.ownerId !== playerId) continue;
    const sp = BOARD[id];
    if (sp.kind === "property") {
      const p = sp as PropertySpace;
      worth += ps.mortgaged ? 0 : p.price;
      worth += ps.buildings * Math.floor(p.buildCost / 2);
    } else if (sp.kind === "air") {
      worth += ps.mortgaged ? 0 : 200;
    } else if (sp.kind === "utility") {
      worth += ps.mortgaged ? 0 : 150;
    }
  }
  return worth;
}

export function canBuild(state: GameState, playerId: number, spaceId: number): boolean {
  const sp = BOARD[spaceId];
  if (sp.kind !== "property") return false;
  const p = sp as PropertySpace;
  const ps = state.properties[spaceId];
  if (ps.ownerId !== playerId) return false;
  if (ps.mortgaged) return false;
  if (!ownsFullGroup(state, playerId, p.group)) return false;
  if (ps.buildings >= 5) return false;
  // even building rule
  const groupIds = COLOR_GROUPS[p.group];
  const minLevel = Math.min(...groupIds.map((id) => state.properties[id].buildings));
  if (ps.buildings > minLevel) return false;
  if (state.players[playerId].cash < p.buildCost) return false;
  return true;
}

export function canSell(state: GameState, playerId: number, spaceId: number): boolean {
  const sp = BOARD[spaceId];
  if (sp.kind !== "property") return false;
  const p = sp as PropertySpace;
  const ps = state.properties[spaceId];
  if (ps.ownerId !== playerId) return false;
  if (ps.buildings <= 0) return false;
  const groupIds = COLOR_GROUPS[p.group];
  const maxLevel = Math.max(...groupIds.map((id) => state.properties[id].buildings));
  if (ps.buildings < maxLevel) return false;
  return true;
}

export function canMortgage(state: GameState, playerId: number, spaceId: number): boolean {
  const ps = state.properties[spaceId];
  if (!ps || ps.ownerId !== playerId || ps.mortgaged) return false;
  const sp = BOARD[spaceId];
  if (sp.kind === "property") {
    const p = sp as PropertySpace;
    // can only mortgage if no buildings on entire group
    const groupIds = COLOR_GROUPS[p.group];
    if (groupIds.some((id) => state.properties[id].buildings > 0)) return false;
  }
  return true;
}

export function canUnmortgage(state: GameState, playerId: number, spaceId: number): boolean {
  const ps = state.properties[spaceId];
  if (!ps || ps.ownerId !== playerId || !ps.mortgaged) return false;
  const sp = BOARD[spaceId];
  let cost = 0;
  if (sp.kind === "property") cost = Math.ceil((sp as PropertySpace).mortgage * 1.1);
  else if (sp.kind === "air") cost = Math.ceil(110);
  else if (sp.kind === "utility") cost = Math.ceil(82);
  return state.players[playerId].cash >= cost;
}

export function unmortgageCost(spaceId: number): number {
  const sp = BOARD[spaceId];
  if (sp.kind === "property") return Math.ceil((sp as PropertySpace).mortgage * 1.1);
  if (sp.kind === "air") return 110;
  if (sp.kind === "utility") return 83;
  return 0;
}

export function priceOf(spaceId: number): number {
  const sp = BOARD[spaceId];
  if (sp.kind === "property") return (sp as PropertySpace).price;
  if (sp.kind === "air") return 200;
  if (sp.kind === "utility") return 150;
  return 0;
}

export function mortgageOf(spaceId: number): number {
  const sp = BOARD[spaceId];
  if (sp.kind === "property") return (sp as PropertySpace).mortgage;
  if (sp.kind === "air") return 100;
  if (sp.kind === "utility") return 75;
  return 0;
}

export function isOwnable(space: Space): boolean {
  return space.kind === "property" || space.kind === "air" || space.kind === "utility";
}

export function nameOf(spaceId: number): string {
  return BOARD[spaceId].name;
}
