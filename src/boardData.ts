// X-opoly board: 40 spaces, indexed 0..39 starting at GO (Closing Day),
// going clockwise: bottom row right-to-left (0..9), left column bottom-to-top (10..19),
// top row left-to-right (20..29), right column top-to-bottom (30..39).

export type ColorGroup =
  | "brown"
  | "lblue"
  | "pink"
  | "orange"
  | "red"
  | "yellow"
  | "green"
  | "dblue";

export type SpaceKind =
  | "go"
  | "property"
  | "air"
  | "utility"
  | "crei"
  | "gala"
  | "tax"
  | "jail"
  | "parking"
  | "gotojail";

export interface PropertySpace {
  id: number;
  kind: "property";
  name: string;
  owner: string;
  handle: string;
  building: string;
  group: ColorGroup;
  price: number;
  baseRent: number;
  rents: [number, number, number, number, number]; // tier 1..5 (Restaurant, Industrial, Multifamily, Retail, Office)
  buildCost: number;
  mortgage: number;
}

export interface AirSpace {
  id: number;
  kind: "air";
  name: string;
  deal: string;
  price: number;
  mortgage: number;
}

export interface UtilitySpace {
  id: number;
  kind: "utility";
  name: string;
  flavor: string;
  price: number;
  mortgage: number;
}

export interface SimpleSpace {
  id: number;
  kind: "go" | "crei" | "gala" | "tax" | "jail" | "parking" | "gotojail";
  name: string;
  sub?: string;
  amount?: number; // for tax
}

export type Space = PropertySpace | AirSpace | UtilitySpace | SimpleSpace;

export const BUILDING_TIER_NAMES = [
  "Restaurant",
  "Industrial",
  "Multifamily",
  "Retail",
  "Office"
];

export const BUILDING_TIER_ICONS = ["RST", "IND", "MFM", "RTL", "OFC"];

const prop = (
  id: number,
  name: string,
  owner: string,
  handle: string,
  building: string,
  group: ColorGroup,
  price: number,
  baseRent: number,
  rents: [number, number, number, number, number],
  buildCost: number
): PropertySpace => ({
  id,
  kind: "property",
  name,
  owner,
  handle,
  building,
  group,
  price,
  baseRent,
  rents,
  buildCost,
  mortgage: Math.floor(price / 2)
});

const air = (id: number, name: string, deal: string): AirSpace => ({
  id,
  kind: "air",
  name,
  deal,
  price: 200,
  mortgage: 100
});

const util = (id: number, name: string, flavor: string): UtilitySpace => ({
  id,
  kind: "utility",
  name,
  flavor,
  price: 150,
  mortgage: 75
});

export const BOARD: Space[] = [
  // 0 GO
  { id: 0, kind: "go", name: "LEVEL UP", sub: "Collect $200 Salary" },
  // bottom row right to left (1..9)
  prop(1, "Clemson Rentals", "Coach Chad Carson", "@CoachChadCarson", "Small-multi / SFR portfolio in Clemson, SC", "brown", 60, 2, [10, 30, 90, 160, 250], 50),
  { id: 2, kind: "gala", name: "RE Gala", sub: "Draw a card" },
  prop(3, "Sweaty Starter Storage", "Nick Huber", "@sweatystartup", "Original Bolt Storage facility, upstate NY", "brown", 60, 4, [20, 60, 180, 320, 450], 50),
  { id: 4, kind: "tax", name: "Property Tax", sub: "Reassessment: $200", amount: 200 },
  air(5, "Hudson Yards Air Rights", "Related Companies"),
  prop(6, "Codie's Laundromat", "Codie Sanchez", "@Codie_Sanchez", "Phoenix laundromat, Main Street Holding Co", "lblue", 100, 6, [30, 90, 270, 400, 550], 50),
  { id: 7, kind: "crei", name: "CREi Summit", sub: "Draw a card" },
  prop(8, "Subto Sub-2 House", "Pace Morby", "@PaceJordanMorby", "Phoenix subject-to creative finance deal", "lblue", 100, 6, [30, 90, 270, 400, 550], 50),
  prop(9, "Triple Net Strip Pad", "Triple Net Investor", "@TripleNetInvest", "Standalone NNN pad site", "lblue", 120, 8, [40, 100, 300, 450, 600], 50),
  // 10 Jail / OFAC Hold
  { id: 10, kind: "jail", name: "JUST VISITING", sub: "OFAC Hold" },
  // left column bottom to top (11..19)
  prop(11, "Dirt Dog: Lake Elsinore", "Aaron Harris", "Dirt Dog Pod", "Dutch Bros, 32250 Mission Trail CA", "pink", 140, 10, [50, 150, 450, 625, 750], 100),
  util(12, "Title Company", "Closing-day chokepoint, rent on dice roll"),
  prop(13, "Dirt Dog: Rio Rancho NM", "Aaron Harris", "Dirt Dog Pod", "Dutch Bros, Rio Rancho NM", "pink", 140, 10, [50, 150, 450, 625, 750], 100),
  prop(14, "Dirt Dog: Beverly Hills HQ", "Aaron Harris", "Dirt Dog Pod", "Dutch Bros development office, Beverly Hills", "pink", 160, 12, [60, 180, 500, 700, 900], 100),
  air(15, "220 Central Park S Air Rights", "Vornado / Steven Roth"),
  prop(16, "Halaris West Hollywood", "Nick Halaris", "@NickHalaris", "Metros Capital design-centric mid-rise", "orange", 180, 14, [70, 200, 550, 750, 950], 100),
  { id: 17, kind: "gala", name: "RE Gala", sub: "Draw a card" },
  prop(18, "LiveFree KC Value-Add", "Logan Freeman", "@livefreeinvestments", "Kansas City multifamily value-add", "orange", 180, 14, [70, 200, 550, 750, 950], 100),
  prop(19, "Bolt Storage Mega-Facility", "Nick Huber", "@sweatystartup", "Flagship Bolt Storage portfolio", "orange", 200, 16, [80, 220, 600, 800, 1000], 100),
  // 20 Free Parking
  { id: 20, kind: "parking", name: "FREE PITCH", sub: "1031 ID Window" },
  // top row left to right (21..29)
  prop(21, "Smoky Mtn Cabin Cluster", "Avery Carl", "@AveryCarl", "Gatlinburg / Pigeon Forge STR portfolio", "yellow", 220, 18, [90, 250, 700, 875, 1050], 150),
  { id: 22, kind: "crei", name: "CREi Summit", sub: "Draw a card" },
  prop(23, "Adaptive Realty Echo Park", "Moses Kagan", "@MosesKagan", "LA vintage apartment building", "yellow", 220, 18, [90, 250, 700, 875, 1050], 150),
  prop(24, "ODC Mobile Home Park", "Brandon Turner", "@BeardyBrandon", "Open Door Capital MHP / multifamily", "yellow", 240, 20, [100, 300, 750, 925, 1100], 150),
  air(25, "270 Park Avenue Air Rights", "JPMorgan Chase HQ"),
  prop(26, "Ashcroft Sun Belt", "Joe Fairless", "@JoeFairless", "Sun Belt apartment community, Ashcroft Capital", "red", 260, 22, [110, 330, 800, 975, 1150], 150),
  prop(27, "Gelt Western Multi", "Keith Wasserman", "@Keith_Wasserman", "Western US apartment community", "red", 260, 22, [110, 330, 800, 975, 1150], 150),
  util(28, "1031 Exchange Co", "Move money in 45 days or pay tax"),
  prop(29, "Fort Capital Industrial", "Chris Powers", "@FortWorthChris", "Class B industrial flex park, Texas", "red", 280, 24, [120, 360, 850, 1025, 1200], 150),
  // 30 Go to Jail
  { id: 30, kind: "gotojail", name: "HAPPY HOUR", sub: "Go to Networking" },
  // right column top to bottom (31..39)
  prop(31, "StripMallGuy Bay Center", "Don Tepman", "@StripMallGuy", "Bay Area strip center, $11M Blackstone deal", "red", 300, 26, [130, 390, 900, 1100, 1275], 150),
  prop(32, "The Aladdin", "Zach Molzer", "@KCmolzer", "$38.5M Aladdin Hotel adaptive reuse, KC", "green", 320, 28, [150, 450, 1000, 1200, 1400], 200),
  { id: 33, kind: "gala", name: "RE Gala", sub: "Draw a card" },
  prop(34, "Holman Building", "Zach Molzer", "@KCmolzer", "Historic KC industrial reposition", "green", 320, 28, [150, 450, 1000, 1200, 1400], 200),
  air(35, "Park Lane Hotel Air Rights", "Witkoff / Macklowe"),
  { id: 36, kind: "crei", name: "CREi Summit", sub: "Draw a card" },
  prop(37, "432 Park Avenue", "Harry Macklowe", "CIM Group", "96-story Park Ave tower, tallest residential western hemisphere", "dblue", 350, 35, [175, 500, 1100, 1300, 1500], 200),
  { id: 38, kind: "tax", name: "Mansion Tax", sub: "Pay $75", amount: 75 },
  prop(39, "One Vanderbilt", "Marc Holliday", "SL Green", "77-story Midtown supertall, built on transferred air rights", "dblue", 375, 38, [190, 525, 1150, 1350, 1550], 200)
];

// 39 is the last; standard Monopoly has 40. Add Hudson Yards back as 40th? We have 40 here (0..39). Good.

export const PROPERTY_INDICES = BOARD.filter((s) => s.kind === "property").map((s) => s.id);
export const AIR_INDICES = BOARD.filter((s) => s.kind === "air").map((s) => s.id);
export const UTILITY_INDICES = BOARD.filter((s) => s.kind === "utility").map((s) => s.id);

export function spaceAt(i: number): Space {
  return BOARD[((i % 40) + 40) % 40];
}

export const COLOR_GROUPS: Record<ColorGroup, number[]> = (() => {
  const out: Record<ColorGroup, number[]> = {
    brown: [],
    lblue: [],
    pink: [],
    orange: [],
    red: [],
    yellow: [],
    green: [],
    dblue: []
  };
  for (const s of BOARD) {
    if (s.kind === "property") out[s.group].push(s.id);
  }
  return out;
})();

export function groupOf(id: number): ColorGroup | null {
  const s = BOARD[id];
  return s.kind === "property" ? s.group : null;
}

export function colorBandClass(g: ColorGroup): string {
  return `${g}-bg`;
}

// Position on the visual 11x11 grid: returns {col, row} 1-indexed.
// Bottom-right is GO (col 11, row 11). Going counter-clockwise visually = clockwise on tile order.
// id 0 (GO) -> col 11, row 11
// ids 1..9 bottom row right-to-left: (col 10..2, row 11)
// id 10 (Jail) -> col 1, row 11
// ids 11..19 left column bottom-to-top: (col 1, row 10..2)
// id 20 (Parking) -> col 1, row 1
// ids 21..29 top row left-to-right: (col 2..10, row 1)
// id 30 (Go to Jail) -> col 11, row 1
// ids 31..39 right column top-to-bottom: (col 11, row 2..10)
export function gridPos(id: number): { col: number; row: number } {
  if (id === 0) return { col: 11, row: 11 };
  if (id >= 1 && id <= 9) return { col: 11 - id, row: 11 };
  if (id === 10) return { col: 1, row: 11 };
  if (id >= 11 && id <= 19) return { col: 1, row: 11 - (id - 10) };
  if (id === 20) return { col: 1, row: 1 };
  if (id >= 21 && id <= 29) return { col: 1 + (id - 20), row: 1 };
  if (id === 30) return { col: 11, row: 1 };
  if (id >= 31 && id <= 39) return { col: 11, row: 1 + (id - 30) };
  return { col: 1, row: 1 };
}
