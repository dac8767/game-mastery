/**
 * Sourcebooks, written out.
 *
 * A Foundry export stores the book as its abbreviation — MotM, ERftLW,
 * SAiS — which is what a compendium key looks like rather than what a
 * book is called. In a column headed Source they read as a code you
 * either know or do not.
 *
 * Two rules, and the second is the interesting one:
 *
 *   known      expanded. "PHB" is Player's Handbook.
 *   unknown    left exactly as it came. A book nobody wrote down here
 *              keeps its abbreviation, which is today's behaviour and
 *              is never worse than a guess.
 *
 * And where the space genuinely will not take it — a Source column
 * dragged narrow — the abbreviation comes back, because a clipped
 * "Mordenkainen Presents: Monsters of the Mu…" says less than "MotM"
 * does.
 *
 * Free of React and Convex so the unit guard can compile it alone.
 */

/**
 * The books this app can name.
 *
 * Abbreviations as Foundry writes them, including the ones that differ
 * between exports for the same book (MPMM and MotM are both Monsters of
 * the Multiverse). Missing a book is not a bug — it keeps its
 * abbreviation — so this list grows when somebody notices a code they
 * had to look up.
 */
export const SOURCE_NAMES: Record<string, string> = {
  // Core
  PHB: "Player's Handbook",
  DMG: "Dungeon Master's Guide",
  MM: "Monster Manual",
  XPHB: "Player's Handbook",
  XDMG: "Dungeon Master's Guide",
  XMM: "Monster Manual",
  SRD: "System Reference Document",

  // Rules expansions
  XGtE: "Xanathar's Guide to Everything",
  TCoE: "Tasha's Cauldron of Everything",
  TCE: "Tasha's Cauldron of Everything",
  MPMM: "Monsters of the Multiverse",
  MotM: "Monsters of the Multiverse",
  MToF: "Mordenkainen's Tome of Foes",
  VGtM: "Volo's Guide to Monsters",
  VGM: "Volo's Guide to Monsters",
  FTD: "Fizban's Treasury of Dragons",
  FToD: "Fizban's Treasury of Dragons",
  SCAG: "Sword Coast Adventurer's Guide",
  EEPC: "Elemental Evil Player's Companion",
  BGG: "Bigby Presents: Glory of the Giants",
  BMT: "The Book of Many Things",
  SatO: "Sigil and the Outlands",

  // Settings
  GGtR: "Guildmasters' Guide to Ravnica",
  GGR: "Guildmasters' Guide to Ravnica",
  ERLW: "Eberron: Rising from the Last War",
  ERftLW: "Eberron: Rising from the Last War",
  EGtW: "Explorer's Guide to Wildemount",
  EGW: "Explorer's Guide to Wildemount",
  MOT: "Mythic Odysseys of Theros",
  VRGtR: "Van Richten's Guide to Ravenloft",
  VRGR: "Van Richten's Guide to Ravenloft",
  SAiS: "Spelljammer: Adventures in Space",
  AI: "Acquisitions Incorporated",

  // Adventures
  CoS: "Curse of Strahd",
  ToA: "Tomb of Annihilation",
  SKT: "Storm King's Thunder",
  OotA: "Out of the Abyss",
  PotA: "Princes of the Apocalypse",
  HotDQ: "Hoard of the Dragon Queen",
  RoT: "The Rise of Tiamat",
  TftYP: "Tales from the Yawning Portal",
  GoS: "Ghosts of Saltmarsh",
  BGDIA: "Baldur's Gate: Descent into Avernus",
  DIP: "Dragon of Icespire Peak",
  WDH: "Waterdeep: Dragon Heist",
  WDMM: "Waterdeep: Dungeon of the Mad Mage",
  IDRotF: "Icewind Dale: Rime of the Frostmaiden",
  CM: "Candlekeep Mysteries",
  WBtW: "The Wild Beyond the Witchlight",
  CRCotN: "Critical Role: Call of the Netherdeep",
  JTtRC: "Journeys through the Radiant Citadel",
  DSotDQ: "Dragonlance: Shadow of the Dragon Queen",
  KftGV: "Keys from the Golden Vault",
  PaBTSO: "Phandelver and Below: The Shattered Obelisk",
  VEoR: "Vecna: Eve of Ruin",
  QftIS: "Quests from the Infinite Staircase",
  LLK: "Lost Laboratory of Kwalish",
  LR: "Locathah Rising",
  TTP: "The Tortle Package",
};

/**
 * The book's full name, keeping any printing year on the end.
 *
 * "PHB 2024" is the abbreviation plus the year the edition rule reads,
 * and both halves matter: expanding the abbreviation and dropping the
 * year would make the 2024 Player's Handbook indistinguishable from the
 * 2014 one in the one column whose job is telling you which book it is.
 */
export function expandSource(source: unknown): string {
  const raw = String(source ?? "").trim();
  if (!raw) return "";

  const withYear = /^(.*\S)\s+(\d{4})$/.exec(raw);
  const base = withYear ? withYear[1] : raw;
  const year = withYear ? ` ${withYear[2]}` : "";

  const full = SOURCE_NAMES[base];
  return full ? `${full}${year}` : raw;
}

/**
 * Roughly how wide a string renders at the table's cell size.
 *
 * An estimate, deliberately: measuring properly means a layout pass per
 * cell on a table that draws three hundred rows. But MEASURED rather
 * than guessed — these two numbers come from rendering the real titles
 * at the real size in the real font, where they ran from 6.87 px/char
 * ("Eberron: Rising from the Last War") to 7.84 ("System Reference
 * Document"), averaging about 7.2.
 *
 * Erring high is the safe direction. Too generous and a name clips
 * mid-word, which is the outcome the abbreviation exists to avoid; too
 * mean and you get the abbreviation you would have had anyway.
 */
const CHAR_PX = 7.4;
const CELL_PADDING_PX = 14;

/**
 * What to write in a Source cell of this width.
 *
 * The full name where it fits, the abbreviation where it does not. A
 * clipped "Mordenkainen Presents: Monsters of the Mu…" is less use than
 * "MotM", which is at least a whole word to somebody who knows it and
 * a searchable one to somebody who does not.
 */
export function sourceLabel(source: unknown, widthPx?: number | null): string {
  const raw = String(source ?? "").trim();
  if (!raw) return "";

  const full = expandSource(raw);
  if (full === raw) return raw; // nothing to shorten back to
  if (typeof widthPx !== "number" || !Number.isFinite(widthPx)) return full;

  return full.length * CHAR_PX + CELL_PADDING_PX <= widthPx ? full : raw;
}

/**
 * A CSS grid track as pixels, or null for one that is not a length.
 *
 * The lookup table's declared widths are strings — "7rem",
 * "minmax(11rem, 2fr)" — and only a resized column is already a number.
 * A track this cannot measure returns null, which the caller reads as
 * "no idea how wide, so write it out".
 */
export function trackPx(track: unknown): number | null {
  const raw = String(track ?? "").trim();
  const rem = /^([\d.]+)rem$/.exec(raw);
  if (rem) return Number(rem[1]) * 16;
  const px = /^([\d.]+)px$/.exec(raw);
  if (px) return Number(px[1]);
  return null;
}
