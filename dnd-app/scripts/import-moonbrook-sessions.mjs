#!/usr/bin/env node
/**
 * Moonbrook's session history, 2021–2026, imported in one run.
 *
 *   node scripts/import-moonbrook-sessions.mjs <campaignId>
 *
 * The records were merged from the OneNote session pages, the Discord
 * #scheduling channel, and — from February 2026 on, after the group
 * gave up on Discord — the Moonbrook Scheduling text thread. The
 * OneNote page content lands as each session's GM notes page.
 *
 * THE NUMBERING HERE IS DEREK'S, read back out of the app after he
 * corrected it: sessions 1 through 53, whole numbers only. An earlier
 * version of this file parked the three games Discord knew about but
 * OneNote never numbered on .5 numbers; he folded those in and
 * renumbered everything after them, and dated the session OneNote
 * left blank (2022-10-07). That numbering is the record, and 54
 * onward continues it. Anything added here later goes in by date and
 * takes the number that falls out of it — never renumber to suit
 * this file.
 *
 * Which is why both passes match on the DATE. Matching on the number
 * is what broke the last run: the summaries were written by number
 * against a campaign that had just been renumbered, so each one
 * landed on the wrong night. A campaign runs one game on a given day,
 * so the date is the identity that survives a renumbering; the number
 * is a label the GM is free to change.
 *
 * A `description` is what HAPPENED IN THE GAME, in a sentence or two —
 * "The party fights the bandits outside of town. One bandit dies." No
 * attendance, no start times, no prep: those are facts about the
 * evening, not about Moonbrook, and the columns beside it already
 * carry the ones worth keeping. Twenty sessions left no record of
 * their events in any source and carry NO description rather than an
 * invented one; everything known about where a date came from lives
 * in that session's GM notes under "Source note".
 *
 * Two passes, both in convex/sessions.ts and both safe to repeat:
 * `importRecords` creates the sessions missing from the campaign and
 * skips any number or date already there, then `setDescriptions`
 * writes the summaries onto the matching dates — clearing the field
 * on the sessions that have no summary, so nothing stale survives.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The regulars, by era. Derek is the GM and is not listed as a player.
const FOUNDERS = ["Alex", "Andrew", "Gaige", "Julie", "Max", "Scott", "Steph"];
const AFTER_GAIGE = ["Alex", "Andrew", "Julie", "Max", "Scott", "Steph"];
const AFTER_ANDREW = ["Alex", "Julie", "Max", "Scott", "Steph"];
const WITH_CAPRICA = ["Alex", "Caprica", "Julie", "Max", "Scott", "Steph"];
const minus = (roster, ...out) => roster.filter((p) => !out.includes(p));

/** Exported so the unit guard can hold this data to the source ledger. */
export const MOONBROOK_SESSIONS = [
  {
    number: 1,
    date: "2021-12-09",
    players: ["Scott", "Max", "Andrew", "Julie", "Gaige"],
    xp: 300,
  },
  {
    number: 2,
    date: "2022-01-13",
    players: ["Max", "Alex", "Julie", "Gaige"],
    xp: 400,
  },
  {
    number: 3,
    date: "2022-01-26",
    players: FOUNDERS,
    xp: 500,
    dmNotes: "<h4>To Do</h4><ol><li>Crypt map</li><li>House maps</li><li>Bar map</li></ol>",
  },
  {
    number: 4,
    date: "2022-02-08",
    players: [],
    xp: 600,
    description:
      "The party explores the cult temple, where the story of the moonstone dragon Ryndelon and his killer Klashandrax is told, and finds the place built around three opposing pairs: fire and water, earth and sky, life and death.",
    dmNotes:
      "<h4>To Do</h4><p>NPC list for townies</p><h4>Outside temple</h4>" +
      "<p>A Dawn of Dragons — Moonstone Dragons. The moonstone dragon Ryndelon, meaning “The Dreamer,” was killed by a red dragon called Klashandrax; the locals started worshipping the red dragon out of fear.</p>" +
      "<h4>Temple</h4>" +
      "<p>3 opposing pairs: fire and water, earth and sky, life and death. All are needed to maintain balance in the world.</p>" +
      "<h4>Guardian chamber</h4><p>Dried blood on the floor.</p>" +
      "<p>Ruby (fire), sapphire (cold), emerald (poison), diamond (thunder), obsidian (necrotic), or opal (radiant).</p>" +
      "<p>Clay Guardian — <code>https://www.dndbeyond.com/monsters/2320433-clay-guardian</code></p>" +
      "<h4>Two side chambers</h4><p>3 spell scrolls each.</p>" +
      "<ul><li>Right: Potion of Fire Resistance, Skyblinder Staff, Deathspeaker Crystal</li><li>Left: Mariner's Armor Chain Shirt, Woodcutter's Axe, Periapt of Wound Closure</li></ul>",
  },
  {
    number: 5,
    date: "2022-02-23",
    players: FOUNDERS,
    xp: 700,
    description:
      "The party visits the painting shop and meets its owner, Biblin Fiddlefen.",
    dmNotes: "<p>Owner of the painting shop: Biblin Fiddlefen.</p>",
  },
  {
    number: 6,
    date: "2022-03-09",
    players: [],
    xp: 800,
    description:
      "The party breaks into the jail basement, past a glyph of explosive runes, and finds a boat waiting on an underground river. Beyond it lies the bandits' cavern camp.",
    dmNotes:
      "<blockquote><p>“That's weird, donkey dad is my handle on…” — Alex</p><p>“Not to save you” — Cylath</p>" +
      "</blockquote><h4>To Do</h4>" +
      "<ul><li>NPC list for locals</li><li>Prison break scenario</li><li>Bandit camp scenario</li><li>Goblin Arcanists scenario</li><li>Magic Tree scenario</li><li>Update map</li><li>Load battle maps</li><li>Organize battlemaps</li></ul>" +
      "<h4>Jail basement</h4>" +
      "<p>At the foot of the door: Explosive Runes. When triggered, the glyph erupts with magical energy in a 20-foot-radius sphere centered on the glyph. The sphere spreads around corners. Each creature in the area must make a Dexterity saving throw. A creature takes 5d8 thunder damage on a failed saving throw, or half as much damage on a successful one.</p>" +
      "<p>Other boxes: 30 rations, +1 ammo × 3, 2 javelins.</p><p>Boat on the underground river.</p>" +
      "<p>Fleur d'vie: fine pink powder, tasteless.</p><h4>Bandit Camp</h4>" +
      "<p>Ten empty bedrolls are arranged in a circle around a cold fire pit at the center of this cavern. Chicken bones, empty wine and spirits bottles, and other food waste litters the floor.</p>" +
      "<p>One of the bedrolls covers the opening of a 10-foot-deep pit trap. The trap can be spotted with a DC 10 Wisdom (Perception) check. If not spotted, anyone walking across the bedroll falls into the pit, taking 3 (1d6) bludgeoning damage and landing prone. A creature that falls into the pit makes enough noise that the bandits in area C2 investigate.</p>" +
      "<p><b>Treasure.</b> Searching all the bedrolls reveals that one contains an unopened bottle of Bald Dwarf Whisky (worth 25 gp), an alcohol made by elves in Uthodurn.</p>",
  },
  {
    number: 7,
    date: "2022-03-30",
    players: [],
    xp: 900,
    dmNotes: "<ul><li>Potion of Bless</li><li>Potion of Feign Death</li><li>Potion of Life Transference</li></ul>",
  },
  {
    number: 8,
    date: "2022-04-13",
    players: minus(FOUNDERS, "Steph"),
    xp: 1000,
    dmNotes:
      "<h4>Summons</h4>" +
      "<ul><li>Summon Beast (2nd)</li><li>Summon Draconic Spirit (5th)</li><li>Summon Aberration (4th)</li><li>Summon Undead (3rd)</li><li>Summon Construct (4th)</li><li>Summon Fey (3rd)</li><li>Summon Shadowspawn (Outsider, 3rd)</li><li>Summon Magical Beast (3rd/5th)</li><li>Summon Giant (5th)</li></ul>" +
      "<h4>To Do</h4>" +
      "<ul><li>Tinkerer encounter<ul><li>Gnome inventor info</li><li>City construct device</li><li>Hint for device</li><li>Books</li></ul>" +
      "</li></ul>",
  },
  {
    number: 9,
    date: "2022-04-27",
    players: minus(FOUNDERS, "Alex"),
    xp: 1100,
    description:
      "The party lies in wait for the cultists to return and fights them when they do. It is a tough battle.",
    dmNotes:
      "<h4>To Do</h4><ul><li>Temple of Life Chamber</li><li>Finalize Greenhouse</li></ul>" +
      "<p><b>Final description:</b> The players waited for the cultists to return and fought them. It was a tough battle.</p>",
  },
  {
    number: 10,
    date: "2022-05-11",
    players: FOUNDERS,
    xp: 1500,
    description:
      "The party searches the abandoned greenhouse of the gnome Liliana Leferrey, whose notes tell of concentrated moonlight, a dangerous specimen out of southern Versant, and the containment failure that ended her work.",
    dmNotes:
      "<h4>To Do — cultist items</h4>" +
      "<ol><li>Ceremonial dagger</li><li>Boots of False Tracks (Common)</li><li>Cloak of Protection</li><li>Driftglobe (Uncommon)</li><li>3 Cult Signets</li></ol>" +
      "<h4>Greenhouse</h4><p>Former owner: Liliana Leferrey, gnomish, female.</p><h4>Office notes</h4>" +
      "<ol><li>May he always protect us? May he always watch over us? Not sure which to write.</li><li>I think the greenhouse addition is finally going to work, and no one will even know!</li><li>Perhaps if I concentrate the moonlight I will see quicker results.</li><li>The test sample from southern Versant is dangerous and powerful. Must keep in isolation tank.</li><li>Adding plant life to the concoction has the most incredible results!</li><li>Containment failure. Badly hurt but contaminated specimen subdued. Need to rest. Sent Modron-8 for supplies.</li></ol>" +
      "<h4>Loot</h4>" +
      "<ul><li>Farmer's Soil</li><li>Paper Bird (Uncommon)</li><li>Restorative Ointment (Uncommon)</li><li>Master's Amulet (Rare)</li><li>100 platinum pieces</li><li>1 moonstone</li></ul>",
  },
  {
    number: 11,
    date: "2022-05-15",
    players: minus(FOUNDERS, "Julie"),
    xp: 1600,
    description:
      "The party tracks down the cult leader and finds he is the town's former mayor. Battle follows.",
    dmNotes: "<p><b>Final description:</b> Game on the roof. Tracked down the cult leader, who turned out to be the former mayor. Battle ensued.</p>",
  },
  {
    number: 12,
    date: "2022-05-25",
    players: FOUNDERS,
    xp: 1700,
    description:
      "A long battle with Fabian leaves Hurron dead. The party carries him back to the temple and revives him, luring Baern in as the sacrifice.",
    dmNotes: "<p><b>Final description:</b> Big battle with Fabian. Hurron died; returned to the temple to revive him, lured Baern in as the sacrifice.</p>",
  },
  {
    number: 13,
    date: "2022-06-15",
    players: FOUNDERS,
    xp: 1800,
    description:
      "The party performs the ritual of life and death, white energy streaming into one chamber and black into the other. In Brendor they drink and gamble with the townsfolk, and a snowball fight breaks out.",
    dmNotes:
      "<p>Read backstories.</p>" +
      "<p>Cloak of Displacement — <code>https://www.dndbeyond.com/magic-items/4605-cloak-of-displacement</code> · Ring of Mind Shielding — <code>https://www.dndbeyond.com/magic-items/4725-ring-of-mind-shielding</code></p>" +
      "<h4>Brendor</h4>" +
      "<ul><li>Dworic Orcfoe — former sheriff, dwarf male, brother of Reikin Orcfoe, starts snowball fight</li><li>Nevil and Kithri High-Hill — rich couple gambling with you, halflings</li><li>Shax Ennui — former town guard, friend, involved in snowball fight and rebuilding house, female tiefling</li><li>Farah Van Wyk — former teacher, female human, friend?, involved in snowball fight and rebuilding house</li><li>Hogar Grumbash Ushat — former logger, involved in snowball fight and rebuilding house, half-orc male</li></ul>" +
      "<p>Rolls: 20 12 16 · 2 16 5 · 4 23 23 · 5 4</p>" +
      "<p>3 disadvantages for being drunk. 1 hr timer to call Reya.</p><h4>Baern Durthane</h4>" +
      "<ul><li>Baern's Bane</li><li>Baern's Pauldron</li><li>Coins: 755 pp, 692 gp, 130 sp</li></ul><h4>Ritual</h4>" +
      "<ul><li>Runes begin to glow white, brighter and brighter, pulsing</li><li>Roll</li><li>The rooms begin to shake</li><li>The ceiling magically disintegrates before your eyes — on one side a blistering hot day (death), on the other a moonlit night (life)</li><li>Roll</li><li>White energy streams into the life chamber, black into the death chamber</li><li>Roll</li></ul>" +
      "<p><b>If it goes well</b></p>" +
      "<ul><li>Moon glows brighter and brighter</li><li>“Hurron, promise me one thing. Promise me you will save this town. Fablan cannot do it alone. It is my life's work, and the life's work of my father and his father before him. Now it will be yours.”</li></ul>" +
      "<p><b>If it goes bad</b></p>" +
      "<ul><li>Black energy spreads beyond the death chamber</li><li>Roof turns brilliantly white</li><li>Flashback to Fabian's “death” scene and the death of his wife</li><li>The flames glow pure white</li><li>Find yourself in infinite white</li><li>A figure appears, a human woman. She is sowing your wounds closed with bright white thread</li><li>She doesn't move her mouth, but you hear her say “Now you must serve him … as I did”</li><li>Wake up</li></ul>",
  },
  {
    number: 14,
    date: "2022-07-06",
    players: [...minus(FOUNDERS, "Scott"), "Hank"],
    xp: 1900,
    description:
      "The party works through the temple's elemental chambers, redirecting water into the right idol's mouth, lighting torches underwater, and bleeding onto the ruins in the chamber of death.",
    dmNotes:
      "<h4>Main room</h4>" +
      "<p>A room with a story, with several idols with open mouths. The PCs would have to redirect water into the correct idol's mouth, based on the story.</p>" +
      "<p>Indication that death has taken over.</p>" +
      "<p>Korkoth took the land; Krashandalon melted the mountain slow and flooded the land, creating the giant lake.</p>" +
      "<h4>Chambers</h4>" +
      "<ul><li><b>Air</b></li><li><b>Earth</b> — connection to earth (teleportation circle)</li><li><b>Fire</b> — torches, must light underwater</li><li><b>Life</b> — heals the party</li><li><b>Death</b> — blood of creation (god bled onto the world creating water, which created life). Must cut themselves and bleed on the ruins</li></ul>" +
      "<h4>Final</h4><p>Kraken + control weather, 3d4 days.</p><p><b>Final description:</b> Made it to…</p>",
  },
  {
    number: 15,
    date: "2022-07-20",
    players: minus(FOUNDERS, "Scott"),
    xp: 2000,
    description:
      "The party fights the kraken.",
    dmNotes: "<p><b>Final description:</b> Fight kraken.</p>",
  },
  {
    number: 16,
    date: "2022-08-10",
    players: minus(FOUNDERS, "Scott"),
    xp: 2100,
    description:
      "The party fights the bandits outside of town. One bandit dies.",
    dmNotes: "<p><b>Final description:</b> Bandit fight, one bandit died.</p>",
  },
  {
    number: 17,
    date: "2022-09-07",
    players: [],
    xp: 2100,
    dmNotes:
      "<h4>To Do</h4>" +
      "<ul><li>Ring of Spell Storing</li><li>Dragontooth Dagger</li><li>Belt of Hill Giant Strength</li></ul>" +
      "<ul><li>Witch items</li><li>Bandit assault items</li><li>Raynar and Reya encounter</li><li>Windmill?</li></ul>",
  },
  {
    number: 18,
    date: "2022-10-07",
    players: [],
    xp: 2300,
    description:
      "The party takes up the offices of Moonbrook: Hurron as lieutenant governor, Cylath minister of merriment, Sylora master of coins, Saia minister of foreign relations, Wynrie minister of culture, Fireplug general of the monster patrol, and Gronn sheriff. A feast follows.",
    dmNotes:
      "<h4>Ministers</h4>" +
      "<ul><li>Hurron — lieutenant governor — 10</li><li>Cylath — Minister of Merryment — 17</li><li>Sylora — master of coins — 22</li><li>Saia — Minister of Foreign Relations — 12</li><li>Wynrie — Minister of Culture — 14</li><li>Fireplug — General of The Monster Patrol — 7</li><li>Gronn — Sheriff — 16</li></ul>" +
      "<h4>Feast</h4>" +
      "<ul><li>Zook</li><li>Myria Underfoot</li><li>Tye Underfoot</li><li>Pavuu Lonehunter</li><li>Clara Sylvaranth</li></ul>" +
      "<h4>House items</h4>" +
      "<ul><li>Baern house items:</li><li>Reya house items:</li><li>Raynar house items:</li></ul>" +
      "<h4>Source note</h4>" +
      "<p>The OneNote page carries no date; the date here is Derek's. The XP total (23,300) places this between the 2022-09-07 and 2022-11-09 games, and its content — the ministers, the feast, the townie roster — is duplicated onto the OneNote page for 2022-11-09.</p>",
  },
  {
    number: 19,
    date: "2022-11-09",
    players: FOUNDERS,
    xp: 0,
    description:
      "Each of the new ministers is granted a boon fitting the office. The party learns of the eladrin coven — Morganna, Azirssa, and Greensong — formed to seize power in the Feywild.",
    dmNotes:
      "<h4>Townies</h4>" +
      "<ul><li>Myria Underfoot</li><li>Tye Underfoot</li><li>Pavuu Lonehunter</li><li>Clara Sylvaranth</li></ul>" +
      "<h4>Eladrin</h4>" +
      "<p>Morganna (summer), Azirssa (winter), and Greensong (autumn). Coven formed to gain power in the Feywild. Azirssa's husband (one of many) was Farworn.</p>" +
      "<h4>Minister boons</h4><p>Each gets an ability/spell, a proficiency, and +2 to a skill.</p>" +
      "<ul><li><b>Hurron — lieutenant governor.</b> Ability: Inspiring Leader. +2 to Persuasion</li><li><b>Cylath — Minister of Merriment.</b> Ability: something to beef up his minions. +2 to Performance</li><li><b>Sylora — master of coins.</b> +2 to Investigation</li><li><b>Saia — Ambassador of Moonbrook.</b> +2 to Survival</li><li><b>Wynrie — Lady of Lore.</b> Proficiency with 2 languages of your choice. +2 to History</li><li><b>Fireplug — General of The Monster Patrol.</b> Ability: Patrol Toll — ring the town bell; all allies within 500 feet get the benefits of the Alert feat for 1 minute. Proficiency with one weapon of your choice. +2 to Perception</li><li><b>Gronn — Sheriff of the Versant Highlands.</b> +2 to Insight</li></ul>" +
      "<h4>Feast</h4>" +
      "<ul><li>Zeek</li><li>Myria Underfoot</li><li>Tye Underfoot</li><li>Pavuu Lonehunter</li><li>Clara Sylvaranth</li></ul>" +
      "<h4>House items</h4>" +
      "<ul><li>Baern house items:</li><li>Reya house items:</li><li>Raynar house items:</li></ul>",
  },
  {
    number: 20,
    date: "2022-11-13",
    players: FOUNDERS,
    xp: 6000,
    description:
      "The battle continues from where it broke off, and is fought to its finish.",
    dmNotes: "<p><b>Final description:</b> Second half of battle.</p>",
  },
  {
    number: 21,
    date: "2022-11-30",
    players: minus(AFTER_GAIGE, "Steph"),
    xp: 2000,
    description:
      "The party turns to rebuilding Moonbrook: the wall, food stores and a fishery, the graveyard, gardens, the gallows, the bell tower, and the ruined jail.",
    dmNotes:
      "<p>Face · Aged · Cage · Fade</p><h4>Town improvements</h4>" +
      "<ul><li>Scott: wall, food, fishery</li><li>Julie: house hunting (wizards), haunted house, Pyra, Reya (braid hair)</li><li>Max: graveyard, everything, cleaning</li><li>Alex: garden, gallows, bell tower</li><li>Andrew: Zook, rebuild jail</li></ul>" +
      "<p>Rolls: 19 Fireplug · 18 Cylath · 12 Wynrie · 11 Gronn · 3 Sylora</p>" +
      "<p><b>Final description:</b> Town improvements.</p>",
  },
  {
    number: 22,
    date: "2023-01-08",
    players: FOUNDERS,
    xp: 2400,
    description:
      "Sylora fights for the prayer necklace of Nes de Gosh. The party comes away with battle spoils and a treasure map, and seven badges are handed out.",
    dmNotes:
      "<h4>Sylora fight</h4>" +
      "<p>Prayer Necklace of Nes de Gosh — <code>https://www.dndbeyond.com/magic-items/6106085-prayer-necklace-of-nes-de-gosh</code> · Sunny's Living Gloves — <code>https://www.dndbeyond.com/magic-items/6106798-sunnys-living-gloves</code></p>" +
      "<h4>Loot</h4><ul><li>Battle loot</li><li>Treasure map</li></ul><h4>Badges</h4>" +
      "<p>7 total. + to skill, + to toolset, + to ability.</p><p>Years · Gears · Cheers · Reveres</p>" +
      "<p>“the fi- the bandit”</p>",
  },
  {
    number: 23,
    date: "2023-01-16",
    players: FOUNDERS,
    xp: 2500,
    description:
      "The party follows the treasure map — the crescent moon, true north, and the steps that brought them there — to a hoard worth some 28,000 gold, past the riddle of a statue raised to protect the people of Moonbrook.",
    dmNotes:
      "<p>Fillias.</p><h4>Map encounter</h4>" +
      "<ol><li>Let the crescent moon guide your way</li><li>True north will lead you to the right path</li><li>Remember the steps you took to get here</li></ol>" +
      "<blockquote><p>I am made of all shapes, but belong in a square,<br>From the end of the steal or a basilisk's stare.<br>A grand simulacrum to pay our respect,<br>And the people of Moonbrook, I was born to protect.</p>" +
      "</blockquote><h4>Loot</h4>" +
      "<p>169 pp · 19,643 gp · 7,500 in rubies and sapphires · 28,833 gold equivalent · 2 diamonds · 1/3 of total loot.</p>",
  },
  {
    number: 24,
    date: "2023-02-05",
    players: FOUNDERS,
    dmNotes:
      "<h4>Random events</h4>" +
      "<ul><li>1 — imminent orc attack</li><li>2 — orc scouting party, large attack soon</li><li>3 — large monster attack</li><li>4–5 — small monster attack (no combat)</li><li>6–8 — bad weather</li><li>7 — good weather</li><li>17–18 — traveling saleswoman</li><li>19–20 — new citizen arrives</li></ul>" +
      "<h4>Prep</h4>" +
      "<ul><li>History book</li><li>Patrol recruits</li><li>Morden info</li><li>Mines</li><li>Clothing list</li><li>Hookup rumors?</li><li>Townhall chat</li><li>Rare metals</li><li>Food per day for town</li></ul>",
  },
  {
    number: 25,
    date: "2023-02-18",
    players: FOUNDERS,
  },
  {
    number: 26,
    date: "2023-04-02",
    players: FOUNDERS,
    description:
      "The party goes down into the mines, and the fight breaks off mid-encounter with enemies in the cart alongside them.",
  },
  {
    number: 27,
    date: "2023-05-07",
    players: minus(FOUNDERS, "Julie"),
    description:
      "A standard dungeon crawl, one of two run back to back.",
  },
  {
    number: 28,
    date: "2023-05-17",
    players: [...minus(AFTER_GAIGE, "Julie", "Steph"), "Drew"],
    description:
      "A standard dungeon crawl, one of two run back to back.",
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>Discord documents this game; OneNote never made a page for it. Discord describes it and the game before it as two “standard dungeon crawls” run back to back.</p>",
  },
  {
    number: 29,
    date: "2023-07-02",
    players: minus(AFTER_GAIGE, "Steph"),
    description:
      "Cylath meets his father, who holds forth on the little kings sprouting like fungus in these new towns, and marks in his son a mind for power.",
    dmNotes:
      "<h4>Cylath's father</h4><p>Leadership “under the proper authority.”</p>" +
      "<blockquote><p>These towns, springing up like a fungus from the pooled entrails of my enemies. These fucking towns are full of little kings now. Rosy-cheeked royalty as thick as flies. Ignorant of what the cost of their easy lives is… what was paid to bring about this era of peace and prosperity.</p>" +
      "</blockquote><p>Cylath has a mind for this business. A mind for power.</p><p>Vog'thirath · Zov</p>" +
      "<h4>NPCs</h4>" +
      "<ul><li>Cecily Haylock — female human, 27 (100), adult, straight</li><li>Duergath Balderk — male hill dwarf, 102 (350), adult, straight</li></ul>" +
      "<p>Bring back baby elks.</p><p>Gruumsh · Jawar</p>",
  },
  {
    number: 30,
    date: "2023-07-22",
    players: minus(AFTER_GAIGE, "Scott"),
  },
  {
    number: 31,
    date: "2023-08-16",
    players: AFTER_GAIGE,
  },
  {
    number: 32,
    date: "2023-08-27",
    players: minus(AFTER_GAIGE, "Steph"),
    description:
      "The party makes its way into the merchant prince's villa, past the gladiators at the entryway and through its garden, bath, and master suite. Poisoned food is left where the orcs will find it.",
    dmNotes:
      "<p>The Red Hand · The Whitecloaks</p><h4>To do</h4>" +
      "<ul><li>Farm</li><li>Mansion</li><li>Update town list</li></ul><h4>Poison roll</h4>" +
      "<ul><li>01–10 — know it is poison</li><li>11–17 — eat the food right away, group dies</li><li>18–21 — orc finds the poison, but uses it for his own means</li><li>22–25 — leader eats it</li></ul>" +
      "<h4>Villa features</h4>" +
      "<ul><li>Portal to a different room</li><li>Secret rooms</li><li>Panic room</li><li>Magic hallway that turns you around</li></ul>" +
      "<h4>Merchant Prince's Villa</h4>" +
      "<ol><li><b>Entryway.</b> Breezy, tiled courtyard with a splashing fountain; washroom left of the entrance. The portico is always guarded by 1d4 + 1 gladiators with advantage on checks and saves against attempts to distract, bamboozle, or charm them. Two-story ceiling, sometimes open to the sky.</li><li><b>Sitting Area.</b> Waiting and meeting area for unknown guests. Rugs and pillows; narrow windows double as arrow slits.</li><li><b>Grand Hall.</b> Magnificently tiled floor flanked by two sweeping staircases to the upper floor.</li><li><b>Guest Rooms.</b> Three private sleeping rooms with baths, two sitting rooms, garden access.</li><li><b>Garden.</b> Ferns, potted palms, orchids, tropical flowers; open to the sky. Rare or poisonous plants for a horticultural prince.</li><li><b>Dining Room.</b> Very low table; diners relax on pillows.</li><li><b>Sauna.</b> In a merchant prince's home a trapped fire elemental provides round-the-clock heat.</li><li><b>Bath.</b> The cornerstone of a Chultan mansion; being invited in is an honor.</li><li><b>Kitchen.</b> Large, high-ceilinged, well ventilated. Stairs to the laundry room.</li><li><b>Library.</b> A character sifting a few hours who makes DC 15 Intelligence (Investigation) finds useful books of Chultan lore among the romances.</li><li><b>Family Rooms.</b> Close family live here; pillows and tiger-skin rugs.</li><li><b>Master Suite.</b> The most opulent room; private bath and walk-in closet. Treasure: two rolls on Gems or Art Objects (Hoard CR 0–4); jewelry 50% in a locked box, DC 15 Dexterity with thieves' tools.</li><li><b>Guard Rooms.</b> Set among the family rooms; 1d4 + 1 fanatically loyal gladiators.</li><li><b>Laundry Room.</b> Washed daily, fanned dry in the humid air.</li><li><b>Servants' Quarters.</b> Isolated from the family areas.</li><li><b>Rain Traps.</b> Every room has at minimum a small basin with running water.</li></ol>" +
      "<p>Source: Port Nyanzaru — Merchant Prince's Villa — <code>https://www.dndbeyond.com/sources/toa/port-nyanzaru#MerchantPrincesVilla</code></p>",
  },
  {
    number: 33,
    date: "2023-09-04",
    players: minus(AFTER_GAIGE, "Steph"),
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>Discord documents this game; OneNote never made a page for it, so no record survives of what happened in it.</p>",
  },
  {
    number: 34,
    date: "2023-09-06",
    players: minus(AFTER_GAIGE, "Steph"),
    description:
      "The party answers the Feywild's riddles and learns of the Schools of Firebloods and their leader, the Fire of Fires — two of the four brotherhoods already dead.",
    dmNotes:
      "<h4>Schools of Firebloods</h4><p>Leader: Fire of Fires.</p>" +
      "<ol><li>The Brotherhood of Elemental Fire — dead</li><li>The Brotherhood of Ethereal Fire</li><li>The Brotherhood of Dragon Fire — dead</li><li>The Brotherhood of Wildfire</li></ol>" +
      "<h4>Spells to include</h4>" +
      "<ol><li>Absorb Elements</li><li>Fire Shield</li><li>Fire Storm</li><li>Wall of Fire</li><li>Immolation</li><li>Illusory Dragon</li><li>Sunbeam</li><li>Dragon's Breath</li></ol>" +
      "<h4>Feywild riddles</h4>" +
      "<ol><li>When brightest, I am darkest. When darkest, I am gone. When I am gone forever, so are you.</li><li>You answer me, but I never ask you a question.</li><li>The more you take, the more you leave behind.</li><li>The maker doesn't want it. The buyer doesn't need it. The user doesn't realize they are using it.</li><li>You see me in a brook, but I never get wet.</li></ol>" +
      "<h4>Royal / Anti-Fireblood</h4>" +
      "<ol><li>Sylora</li><li>Leshanna</li><li>Zanny</li><li>Daisy</li><li>Jed and Zaralynn Grady</li></ol>",
  },
  {
    number: 35,
    date: "2023-09-12",
    players: minus(AFTER_GAIGE, "Steph"),
    description:
      "Gronn's story arc comes to its end.",
  },
  {
    number: 36,
    date: "2023-11-05",
    players: AFTER_ANDREW,
    description:
      "The party investigates the empty houses of the town, among them the magician's and the tech griffon house.",
  },
  {
    number: 37,
    date: "2023-11-19",
    players: minus(AFTER_GAIGE, "Steph"),
  },
  {
    number: 38,
    date: "2024-01-20",
    players: AFTER_ANDREW,
    description:
      "The party walks the Astral Plane, that silvery sea of thought and dream, and receives the prophecy: once the ash meets sky and ground, a new age begins when water meets fire.",
    dmNotes:
      "<p>Vote on Gaige.</p>" +
      "<p>The Astral Plane is the realm of thought and dream, where visitors travel as disembodied souls to reach the planes of the divine and demonic. It is a great, silvery sea, the same above and below, with swirling wisps of white and gray streaking among motes of light resembling distant stars. Erratic whirlpools of color flicker in midair like spinning coins. Occasional bits of solid matter can be found here, but most of the Astral Plane is an endless, open domain.</p>" +
      "<blockquote><p>Tales woven new from life and death,<br>In dreams where silent sleep retires,<br>They drank the wine of river Lethe,<br>Incurred the wrath of dragon's breath,<br>And cursed their kin to pain and pyre</p>" +
      "<p>But once the ash meets sky and ground,<br>Beneath the moon's pale, ghostly spire.<br>A future forged, and balance found<br>The hidden caliph claimed and crowned,<br>A new age begins, when water meets fire.</p>" +
      "</blockquote>",
  },
  {
    number: 39,
    date: "2024-02-25",
    players: minus(AFTER_GAIGE, "Scott", "Steph"),
  },
  {
    number: 40,
    date: "2024-03-31",
    players: AFTER_ANDREW,
    description:
      "An egg hunt scatters magic items, potions, and the pieces of a shattered amulet across the town, and new townsfolk arrive — lumberjacks, a harengon farming family, healers, guards, miners, and a blacksmith. The party leaves the wizard's house to find that time has passed, the mayor is stepping down, and an election has been called for.",
    dmNotes:
      "<h4>To do</h4>" +
      "<ul><li>Egg encounter design</li><li>Assorted items for eggs</li><li>Town aftermath</li><li>Lore writeups</li><li>Rake</li><li>Hide eggs</li></ul>" +
      "<p>Crown of the Sea Queen — <code>https://www.dndbeyond.com/magic-items/8251839-crown-of-the-sea-queen</code></p>" +
      "<h4>Egg loot</h4>" +
      "<ol><li>Nature's Mantle</li><li>Robe of Eyes</li><li>Arrow of Many Targets (homebrew)</li><li>Insignia of Claws</li><li>Amulet of Health</li><li>Atlas of Endless Horizons</li><li>Chime of Opening</li><li>Arcane Oil</li><li>Potion of Giant Size</li><li>Thought strand × 6 (10–15)</li><li>Coins × 5 (16–20)</li><li>Potion of Superior Healing × 2 (21–22)</li><li>Potion of Supreme Healing (23)</li><li>Potion of Invulnerability (24)</li><li>Ring of Regeneration (25)</li><li>Ring of Fire Resistance (26)</li><li>Ring of Telekinesis (27)</li><li>Ring of Feather Falling (28)</li><li>Shattered amulet × 11 (29–39)</li></ol>" +
      "<h4>New townsfolk</h4>" +
      "<p><b>Lumberjacks (dwarves):</b> Nalral, Nordak, Nuraval, Marastyr, Mardred, Morana.</p>" +
      "<p><b>Farmers (harengons):</b> Hazel (mother), Walnut (father); daughters Puffer, Softtail, Whistkers, Hiphop, Fluffikins, Fuzzball, Snowball, Snugglebun; sons Cottontail, Blueberry, Furbun, Floofears, Steve.</p>" +
      "<p><b>Healers:</b> Gabreel (doctor, tiefling, F), Sisava (nurse, yuan-ti, M), Greline (nurse, bugbear, F).</p>" +
      "<p><b>Hunter:</b> Arturo (human, M).</p>" +
      "<p><b>Cleric of Selune:</b> Marama (air genasi, F; origin: Maori).</p>" +
      "<p><b>Teacher:</b> Nisson Wordpainter (goliath, M).</p>" +
      "<p><b>Guards:</b> Hoover (owlin, M), Arbidexter Frosh (giff, M), LaLa (hadozee, F).</p>" +
      "<p><b>Merchants:</b> mill, flowers, knick knacks, books, animals.</p>" +
      "<p><b>Blacksmith:</b> Daaaar (dragonborn, F, fire).</p>" +
      "<p><b>Expert miners (deep gnomes):</b> Roywyn (F), Kipper (M), Fonkin (M), Brocc (M). Geologist: Ellywick (F).</p>",
  },
  {
    number: 41,
    date: "2024-06-02",
    players: minus(AFTER_ANDREW, "Scott"),
  },
  {
    number: 42,
    date: "2024-06-09",
    players: minus(AFTER_ANDREW, "Scott"),
    description:
      "The party calls on Andraste the shapeshifting modiste and Niobe the fortune teller, who takes their questions — Wynrie asks whether she will ever meet her parents, and whether they loved her.",
    dmNotes:
      "<h4>Andraste — modiste</h4><p>Olive skin. Gleaming fabric. Shapeshifting.</p><h4>Niobe — fortune teller</h4>" +
      "<ul><li>Cylath —</li><li>Fireplug —</li><li>Saia —</li><li>Wynrie — Will I ever meet my parents? Did they love me?</li></ul>" +
      "<p>Robe of Lies.</p><p>5 prisoners.</p>",
  },
  {
    number: 43,
    date: "2024-07-21",
    players: AFTER_ANDREW,
    description:
      "Twenty-two attackers come down on the party: two griffon riders, a hill giant, four worgs, and sixteen more on foot.",
    dmNotes:
      "<h4>Enemies</h4>" +
      "<ul><li>2 griffon riders</li><li>Hill giant</li><li>4 worgs</li><li>16 unmounted</li><li>22 total</li></ul>" +
      "<h4>To do</h4><ul><li>Map</li><li>Bean options</li></ul>",
  },
  {
    number: 44,
    date: "2024-10-12",
    players: AFTER_GAIGE,
    description:
      "Sylora descends into the Earth Temple, whose gifts run to earthquake, transport via plants, and the fertility to revive the fleur de vie.",
    dmNotes:
      "<h4>Earth Temple abilities</h4>" +
      "<ol><li>Earthquake — <code>https://www.dndbeyond.com/spells/2619160-earthquake</code></li><li>Transport via Plants — <code>https://www.dndbeyond.com/spells/2619196-transport-via-plants</code></li><li>Mirage Arcane — <code>https://www.dndbeyond.com/spells/2619040-mirage-arcane</code></li><li>Fertility: revive the fleur de vie</li><li>Item that gives spells based on Circle of the Land spells, and a special wildshape</li></ol>" +
      "<p>Goth ro blades — Lord of Blades.</p>",
  },
  {
    number: 45,
    date: "2024-10-13",
    players: AFTER_GAIGE,
    description:
      "The battle with the orcs begins.",
    dmNotes: "<p>Battle pt 1.</p>",
  },
  {
    number: 46,
    date: "2024-10-14",
    players: [],
    description:
      "The orc battle is fought to its end.",
    dmNotes:
      "<p>Battle pt 2.</p><h4>Source note</h4>" +
      "<p>Conflict between the sources. OneNote has a page dated 10/14/24 reading “Battle pt 2,” but Discord planned and confirmed a two-day Orc Weekend only — 10/12 and 10/13 — called the Monday a rest day, and carries no messages at all on 10/14. The OneNote pages for 10/13 and 10/14 were both created at the same timestamp, mid-game on the Sunday. This may be an unused stub for a battle that finished on the Sunday.</p>",
  },
  {
    number: 47,
    date: "2024-12-14",
    players: minus(AFTER_ANDREW, "Steph"),
    xp: 0,
    description:
      "Sylora's descent into the Earth Temple ends in the Trials of Gosh: fertilizing barren soil with the fallen, sowing a token of the past, growing vines down the crevasse, and nursing the dying great tree back to life.",
    dmNotes:
      "<h4>Trials of Gosh</h4>" +
      "<ul><li><b>Cultivate thy Faith</b> — dead orc bodies, can “fertilize the soil”</li><li><b>Sow a new Path</b> — prove your devotion; plant an adequate item into the ground and roots open a passage</li><li><b>Grow thy Zeal</b> — plant growth to create vines down the crevasse</li><li><b>Nurture thy Lord</b> — heal the dying tree</li><li><b>Reap thy Rewards</b> — what is her reward?</li></ul>" +
      "<h4>Tenets</h4>" +
      "<ol><li>Grow with Patience and Purpose</li><li>Root Thyself in Faith (devotion)</li><li>Nurture thy Earth, Nurture thy Self</li></ol>" +
      "<h4>Verses</h4>" +
      "<ul><li><b>Cultivate thy Faith:</b> “Where the earth lies barren and the fallen decay, awaken the soil to find the right way”</li><li><b>Sow a new Path:</b> “sow a token of the past to start anew, but unworthy a seed makes many the few”</li><li><b>Grow thy Zeal:</b> “When no way forward can be found, embrace your abilities of boundless ground.”</li><li><b>Nurture thy Lord:</b> “The great tree falters, its lifeblood fades; revive the bringer of life, and the glory of gosh cascades.”</li><li><b>Reap thy Rewards:</b> “The faithful shall find their harvest; her givings awash, so blessed are the devoted to the goddess gosh”</li></ul>" +
      "<p>The tenets of faith will show you the path, but falter in faith and incur the lord's wrath.</p>",
  },
  {
    number: 48,
    date: "2025-03-16",
    players: AFTER_ANDREW,
    dmNotes: "<h4>Source note</h4><p>No OneNote page survives for this game; it is documented in Discord only.</p>",
  },
  {
    number: 49,
    date: "2025-04-20",
    players: minus(AFTER_ANDREW, "Steph"),
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>An informal “session 0” refresh, documented in Discord only — the party talked through where each character's story needed to go before the end of the campaign.</p>",
  },
  {
    number: 50,
    date: "2025-05-03",
    players: minus(AFTER_GAIGE, "Steph"),
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>No OneNote page survives for this game; it is documented in Discord only. Derek ran it without prep.</p>",
  },
  {
    number: 51,
    date: "2025-06-01",
    players: minus(AFTER_ANDREW, "Steph"),
    description:
      "The party descends into the catacombs beneath the Death Temple, where a tomb's floor opens only for the fully entombed and the last chamber admits only those who pass through death itself. One of them dies there, and comes back.",
    dmNotes:
      "<h4>Puzzle ideas</h4>" +
      "<ul><li>Catacombs — a secret passage is inside a tomb; only when completely entombed does the bottom open to a level below</li><li>Gravestone — a game of “Guess Who” to determine which grave is the correct one</li><li>To enter the final chamber, one must “pass through death” itself — must kill themselves to see the other side</li></ul>" +
      "<h4>Catacombs</h4>" +
      "<ol><li>Each night we lie in gentle graves, rehearsing the stillness that waits beyond waking.</li><li>In death we do not vanish, but drift into the stillness between heartbeats, where even dreams dare not stir.</li><li>There is no peace until returned to the ground, for out of it you were taken. Dust you are, and to dust you will return.</li><li>Death does not count. I have only slipped away into the next room. Nothing has happened.</li><li>Do not fear this final repose. The quiet is kind where pain is forgotten.</li><li>Once I dreamt of death, and now it dreams of me.</li></ol>" +
      "<blockquote><p>There is but one path, one destination: to sink into the sands of time. Do not waste a whisper delaying death's cold kiss. The sands are ceaseless, and the breath you borrowed must be paid in silence.</p>" +
      "</blockquote><p>Write about an evil entity that sought eternal life.</p>" +
      "<p><b>The adversary of life is not death, but life eternal.</b></p><h4>Kelemvor</h4>" +
      "<p>Kelemvor, formerly Kelemvor Lyonsbane, also known as the Lord of the Dead and Judge of the Damned, is the god of death and the dead, and master of the Crystal Spire in the Fugue Plane.</p>" +
      "<p>Fair yet cold, Kelemvor is the god of death and the dead — the most recent deity to hold this position, following in the footsteps of Jergal, Myrkul, and Cyric. Unlike these other deities, whose rule as gods of the dead made the afterlife an uncertain and fearful thing, Kelemvor promoted that death was a natural part of life and should not be feared as long as it was understood.</p>" +
      "<p>Domains: Death, Grave. Alignment: Lawful Neutral.</p><h4>Source note</h4>" +
      "<p>The OneNote page was created 2025-05-26 for the Memorial Day game, which slipped a week; the date here is the night it was actually played, from Discord.</p>",
  },
  {
    number: 52,
    date: "2025-09-14",
    players: WITH_CAPRICA,
  },
  {
    number: 53,
    date: "2025-11-23",
    players: minus(WITH_CAPRICA, "Scott"),
  },
  {
    number: 54,
    date: "2026-03-14",
    players: WITH_CAPRICA,
    description:
      "Saia's story takes the spotlight at last. The party levels to eleven and sits down to a hero's feast, keeping its blessings for the battle ahead.",
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>From the Moonbrook Scheduling text thread, which the group moved to from Discord in February 2026 after four months of failed scheduling. Everyone was there. The party had been told two days earlier they could level to eleven — the idea being to level at the START of a big fight rather than after it, so the new abilities get used — and the session ended with the reminder that everyone is carrying hero's feast effects into the next fight.</p>",
  },
  {
    number: 55,
    date: "2026-05-23",
    players: WITH_CAPRICA,
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>From the Moonbrook Scheduling text thread. Everyone was there — a full house. Nothing survives about what happened in the game; the encounter deferred from the cancelled Easter game was described beforehand as one of the hardest fights the campaign has had, but nothing confirms it was played here.</p>",
  },
  {
    number: 56,
    date: "2026-06-20",
    players: WITH_CAPRICA,
    description:
      "The party fights the battle it has been building toward, out in open ground.",
    dmNotes:
      "<h4>Source note</h4>" +
      "<p>From the Moonbrook Scheduling text thread. Scott played remotely over Discord voice, which was workable because the fight was in the open rather than a tactical one. The next game was set for the air temple, which Derek has also been calling the sky temple.</p>",
  },
];

// ---------------------------------------------------------------------

function main() {
  const campaignId = process.argv[2];
  if (!campaignId) {
    console.error(
      "Usage: node scripts/import-moonbrook-sessions.mjs <campaignId>\n\n" +
        "  The campaign id is in the address bar on any Moonbrook screen:\n" +
        "  /campaign/<campaignId>/sessions"
    );
    process.exit(1);
  }

  const BATCH = 6;
  let campaignName = null;

  /** One `npx convex run`, with the batch named if it fails. */
  const call = (fn, args, what) => {
    const run = spawnSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
      encoding: "utf8",
    });
    if (run.status !== 0) {
      console.error(run.stdout ?? "");
      console.error(run.stderr ?? "");
      console.error(
        `\nFailed on ${what}. Nothing in that batch was written; ` +
          "everything before it was. Fix the error and run the script " +
          "again — both passes are safe to repeat."
      );
      process.exit(1);
    }
    const m = /\{[^{}]*\}/.exec(run.stdout ?? "");
    const out = m ? JSON.parse(m[0]) : null;
    if (out?.campaign) campaignName = out.campaign;
    return out;
  };

  // Pass one: the sessions themselves. Numbers already in the campaign
  // are left exactly as they are.
  let created = 0;
  let skipped = 0;
  for (let at = 0; at < MOONBROOK_SESSIONS.length; at += BATCH) {
    const chunk = MOONBROOK_SESSIONS.slice(at, at + BATCH);
    const span = `sessions ${chunk[0].number}–${chunk[chunk.length - 1].number}`;
    const out = call(
      "sessions:importRecords",
      { campaignId, records: chunk },
      span
    );
    created += out?.created ?? 0;
    skipped += out?.skipped ?? 0;
    console.log(`${span}: imported`);
  }

  // Pass two: the summaries, keyed by DATE onto whatever is there —
  // including records an earlier run created and the GM has since
  // renumbered. EVERY session is sent, the ones with no summary as an
  // empty string, so a withdrawn summary clears the old text rather
  // than leaving it behind for want of anything to overwrite it.
  const entries = MOONBROOK_SESSIONS.map((r) => ({
    date: r.date,
    description: r.description ?? "",
  }));
  let written = 0;
  let cleared = 0;
  let missing = 0;
  for (let at = 0; at < entries.length; at += 20) {
    const chunk = entries.slice(at, at + 20);
    const out = call(
      "sessions:setDescriptions",
      { campaignId, entries: chunk },
      `summaries from ${chunk[0].date}`
    );
    written += out?.written ?? 0;
    cleared += out?.cleared ?? 0;
    missing += out?.missing ?? 0;
  }
  console.log("summaries: written");

  console.log(
    `\n${campaignName ?? "Campaign"}: ${created} session${
      created === 1 ? "" : "s"
    } created, ${skipped} already there and left alone, ` +
      `${written} summar${written === 1 ? "y" : "ies"} written, ` +
      `${cleared} cleared.`
  );
  if (missing > 0) {
    console.log(
      `\n${missing} of these dates matched no session in the campaign. ` +
        "That means a date was corrected in the app but not here — the " +
        "records in this file are keyed by date, so fix the date here " +
        "and run it again."
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
