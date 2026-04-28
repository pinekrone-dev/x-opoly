export type CardEffectType =
  | "collect"
  | "pay"
  | "moveTo"
  | "moveBy"
  | "goToJail"
  | "getOutFree"
  | "collectFromEach"
  | "payEach"
  | "payPerProperty";

export interface CardEffect {
  type: CardEffectType;
  amount?: number;
  target?: number; // space id for moveTo
  steps?: number; // signed for moveBy
  perProperty?: number; // for payPerProperty
  collectIfPass?: boolean;
}

export interface Card {
  id: string;
  text: string;
  effect: CardEffect;
}

// CREi Summit (Chance) - mix of movement, gain, loss
export const CREI_SUMMIT_CARDS: Card[] = [
  { id: "c01", text: "ULI panel slot accepted. Collect $200.", effect: { type: "collect", amount: 200 } },
  { id: "c02", text: "DSCR ratio failed. Go directly to OFAC Hold.", effect: { type: "goToJail" } },
  { id: "c03", text: "CREi Summit attendee invests in your portfolio. Collect $150 from each opponent.", effect: { type: "collectFromEach", amount: 150 } },
  { id: "c04", text: "Snagged a 1031 exchange. Advance to 1031 Exchange Co.", effect: { type: "moveTo", target: 28, collectIfPass: true } },
  { id: "c05", text: "Construction loan extended. Bank charges 2 percent. Pay $100.", effect: { type: "pay", amount: 100 } },
  { id: "c06", text: "Closing wire hits early. Advance to Closing Day and collect $200.", effect: { type: "moveTo", target: 0, collectIfPass: false } },
  { id: "c07", text: "Get out of OFAC Hold free. Keep this card.", effect: { type: "getOutFree" } },
  { id: "c08", text: "Featured on the cover of CRE Daily. Collect $75.", effect: { type: "collect", amount: 75 } },
  { id: "c09", text: "LP capital call. Pay $50 per property held.", effect: { type: "payPerProperty", perProperty: 50 } },
  { id: "c10", text: "Advance to 30 Hudson Yards. Collect $200 if you pass Closing Day.", effect: { type: "moveTo", target: 5, collectIfPass: true } },
  { id: "c11", text: "Cap rate compression boosts your exit. Collect $250.", effect: { type: "collect", amount: 250 } },
  { id: "c12", text: "Advance to The Aladdin. Collect $200 if you pass Closing Day.", effect: { type: "moveTo", target: 32, collectIfPass: true } },
  { id: "c13", text: "Surprise tax bill from your accountant. Pay $75.", effect: { type: "pay", amount: 75 } },
  { id: "c14", text: "Move back 3 spaces. Reposition the deal.", effect: { type: "moveBy", steps: -3 } },
  { id: "c15", text: "Advance to OFAC Hold. Do not pass Closing Day. Do not collect $200.", effect: { type: "goToJail" } },
  { id: "c16", text: "Speaker fee from the Summit stage. Collect $150.", effect: { type: "collect", amount: 150 } }
];

// RE Gala (Community Chest)
export const RE_GALA_CARDS: Card[] = [
  { id: "g01", text: "Tenant Improvement allowance approved. Pay $50.", effect: { type: "pay", amount: 50 } },
  { id: "g02", text: "Refinance proceeds wire in. Collect $300.", effect: { type: "collect", amount: 300 } },
  { id: "g03", text: "Get out of OFAC Hold free. Keep this card.", effect: { type: "getOutFree" } },
  { id: "g04", text: "Roof replacement on a Class B asset. Pay $100.", effect: { type: "pay", amount: 100 } },
  { id: "g05", text: "RE Gala silent auction win. Collect $100.", effect: { type: "collect", amount: 100 } },
  { id: "g06", text: "Property insurance refund. Collect $50.", effect: { type: "collect", amount: 50 } },
  { id: "g07", text: "GP promote distribution clears. Collect $200.", effect: { type: "collect", amount: 200 } },
  { id: "g08", text: "Black-tie ticket and bar tab. Pay $40.", effect: { type: "pay", amount: 40 } },
  { id: "g09", text: "Advance to Closing Day. Collect $200.", effect: { type: "moveTo", target: 0, collectIfPass: false } },
  { id: "g10", text: "Earnest money returned. Collect $25 from each opponent.", effect: { type: "collectFromEach", amount: 25 } },
  { id: "g11", text: "Snow removal contract overrun. Pay $30.", effect: { type: "pay", amount: 30 } },
  { id: "g12", text: "Mortgage broker rebate. Collect $50.", effect: { type: "collect", amount: 50 } },
  { id: "g13", text: "Property tax appeal won. Collect $75.", effect: { type: "collect", amount: 75 } },
  { id: "g14", text: "Late rent on three units. Collect $25.", effect: { type: "collect", amount: 25 } },
  { id: "g15", text: "DSCR Failed. Go directly to OFAC Hold.", effect: { type: "goToJail" } },
  { id: "g16", text: "Emergency CapEx assessment. Pay $100 per property held.", effect: { type: "payPerProperty", perProperty: 100 } }
];

export function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
