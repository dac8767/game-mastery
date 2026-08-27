#!/usr/bin/env node
/**
 * Moonbrook's session history, 2021–2025, imported in one run.
 *
 *   node scripts/import-moonbrook-sessions.mjs <campaignId>
 *
 * The records were merged from the OneNote session pages and the
 * Discord #scheduling channel. Dates follow the manually typed `Date:`
 * field on each OneNote page; the three sessions Discord knows about
 * but OneNote never numbered ride between their neighbours as .5
 * numbers (27.5, 31.5, 46.5), and each says so in its description.
 * The OneNote page content lands as each session's DM notes page.
 *
 * The heavy lifting is convex/sessions.ts `importRecords`, called here
 * through `npx convex run` in small batches so no single argument list
 * gets huge. Existing session NUMBERS are skipped, never overwritten,
 * so this is safe to run twice — the second run just reports skips.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The regulars, by era. Derek is the DM and is not listed as a player.
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
    description: "First session. Derek + 5.",
  },
  {
    number: 2,
    date: "2022-01-13",
    players: ["Max", "Alex", "Julie", "Gaige"],
    xp: 400,
    description: "Alex's first session; Scott and Andrew out.",
  },
  {
    number: 3,
    date: "2022-01-26",
    players: FOUNDERS,
    xp: 500,
    description: "To-do: crypt, house, and bar maps.",
    dmNotes:
      "<h4>To Do</h4><ol><li>Crypt map</li><li>House maps</li><li>Bar map</li></ol>",
  },
  {
    number: 4,
    date: "2022-02-08",
    players: [],
    xp: 600,
    description: "Cult Temple. Three opposing pairs: fire/water, earth/sky, life/death.",
    dmNotes:
      "<h4>To Do</h4><p>NPC list for townies</p>" +
      "<h4>Outside temple</h4><p>A Dawn of Dragons — Moonstone Dragons. The moonstone dragon Ryndelon, meaning “The Dreamer,” was killed by a red dragon called Klashandrax; the locals started worshipping the red dragon out of fear.</p>" +
      "<h4>Temple</h4><p>3 opposing pairs: fire and water, earth and sky, life and death. All are needed to maintain balance in the world.</p>" +
      "<h4>Guardian chamber</h4><p>Dried blood on the floor.</p><p>Ruby (fire), sapphire (cold), emerald (poison), diamond (thunder), obsidian (necrotic), or opal (radiant).</p>" +
      "<p>Clay Guardian — <code>https://www.dndbeyond.com/monsters/2320433-clay-guardian</code></p>" +
      "<h4>Two side chambers</h4><p>3 spell scrolls each.</p><ul><li>Right: Potion of Fire Resistance, Skyblinder Staff, Deathspeaker Crystal</li><li>Left: Mariner's Armor Chain Shirt, Woodcutter's Axe, Periapt of Wound Closure</li></ul>",
  },
  {
    number: 5,
    date: "2022-02-23",
    players: FOUNDERS,
    xp: 700,
    description: "Biblin Fiddlefen and the painting shop.",
    dmNotes: "<p>Owner of the painting shop: Biblin Fiddlefen.</p>",
  },
  {
    number: 6,
    date: "2022-03-09",
    players: [],
    xp: 800,
    description: "Jail basement, bandit camp.",
    dmNotes:
      "<blockquote><p>“That's weird, donkey dad is my handle on…” — Alex</p><p>“Not to save you” — Cylath</p></blockquote>" +
      "<h4>To Do</h4><ul><li>NPC list for locals</li><li>Prison break scenario</li><li>Bandit camp scenario</li><li>Goblin Arcanists scenario</li><li>Magic Tree scenario</li><li>Update map</li><li>Load battle maps</li><li>Organize battlemaps</li></ul>" +
      "<h4>Jail basement</h4><p>At the foot of the door: Explosive Runes. When triggered, the glyph erupts with magical energy in a 20-foot-radius sphere centered on the glyph. The sphere spreads around corners. Each creature in the area must make a Dexterity saving throw. A creature takes 5d8 thunder damage on a failed saving throw, or half as much damage on a successful one.</p>" +
      "<p>Other boxes: 30 rations, +1 ammo × 3, 2 javelins.</p><p>Boat on the underground river.</p><p>Fleur d'vie: fine pink powder, tasteless.</p>" +
      "<h4>Bandit Camp</h4><p>Ten empty bedrolls are arranged in a circle around a cold fire pit at the center of this cavern. Chicken bones, empty wine and spirits bottles, and other food waste litters the floor.</p>" +
      "<p>One of the bedrolls covers the opening of a 10-foot-deep pit trap. The trap can be spotted with a DC 10 Wisdom (Perception) check. If not spotted, anyone walking across the bedroll falls into the pit, taking 3 (1d6) bludgeoning damage and landing prone. A creature that falls into the pit makes enough noise that the bandits in area C2 investigate.</p>" +
      "<p><b>Treasure.</b> Searching all the bedrolls reveals that one contains an unopened bottle of Bald Dwarf Whisky (worth 25 gp), an alcohol made by elves in Uthodurn.</p>",
  },
  {
    number: 7,
    date: "2022-03-30",
    players: [],
    xp: 900,
    dmNotes:
      "<ul><li>Potion of Bless</li><li>Potion of Feign Death</li><li>Potion of Life Transference</li></ul>",
  },
  {
    number: 8,
    date: "2022-04-13",
    players: minus(FOUNDERS, "Steph"),
    xp: 1000,
    description: "Summon-spell list. Steph out.",
    dmNotes:
      "<h4>Summons</h4><ul><li>Summon Beast (2nd)</li><li>Summon Draconic Spirit (5th)</li><li>Summon Aberration (4th)</li><li>Summon Undead (3rd)</li><li>Summon Construct (4th)</li><li>Summon Fey (3rd)</li><li>Summon Shadowspawn (Outsider, 3rd)</li><li>Summon Magical Beast (3rd/5th)</li><li>Summon Giant (5th)</li></ul>" +
      "<h4>To Do</h4><ul><li>Tinkerer encounter<ul><li>Gnome inventor info</li><li>City construct device</li><li>Hint for device</li><li>Books</li></ul></li></ul>",
  },
  {
    number: 9,
    date: "2022-04-27",
    players: minus(FOUNDERS, "Alex"),
    xp: 1100,
    description: "Waited for the cultists; tough battle. Alex out.",
    dmNotes:
      "<h4>To Do</h4><ul><li>Temple of Life Chamber</li><li>Finalize Greenhouse</li></ul>" +
      "<p><b>Final description:</b> The players waited for the cultists to return and fought them. It was a tough battle.</p>",
  },
  {
    number: 10,
    date: "2022-05-11",
    players: FOUNDERS,
    xp: 1500,
    description: "The greenhouse. XP jumps off the +100 pattern here.",
    dmNotes:
      "<h4>To Do — cultist items</h4><ol><li>Ceremonial dagger</li><li>Boots of False Tracks (Common)</li><li>Cloak of Protection</li><li>Driftglobe (Uncommon)</li><li>3 Cult Signets</li></ol>" +
      "<h4>Greenhouse</h4><p>Former owner: Liliana Leferrey, gnomish, female.</p>" +
      "<h4>Office notes</h4><ol><li>May he always protect us? May he always watch over us? Not sure which to write.</li><li>I think the greenhouse addition is finally going to work, and no one will even know!</li><li>Perhaps if I concentrate the moonlight I will see quicker results.</li><li>The test sample from southern Versant is dangerous and powerful. Must keep in isolation tank.</li><li>Adding plant life to the concoction has the most incredible results!</li><li>Containment failure. Badly hurt but contaminated specimen subdued. Need to rest. Sent Modron-8 for supplies.</li></ol>" +
      "<h4>Loot</h4><ul><li>Farmer's Soil</li><li>Paper Bird (Uncommon)</li><li>Restorative Ointment (Uncommon)</li><li>Master's Amulet (Rare)</li><li>100 platinum pieces</li><li>1 moonstone</li></ul>",
  },
  {
    number: 11,
    date: "2022-05-15",
    players: minus(FOUNDERS, "Julie"),
    xp: 1600,
    description: "Rooftop game. Julie out.",
    dmNotes:
      "<p><b>Final description:</b> Game on the roof. Tracked down the cult leader, who turned out to be the former mayor. Battle ensued.</p>",
  },
  {
    number: 12,
    date: "2022-05-25",
    players: FOUNDERS,
    xp: 1700,
    description: "Fabian battle; Hurron died and was revived.",
    dmNotes:
      "<p><b>Final description:</b> Big battle with Fabian. Hurron died; returned to the temple to revive him, lured Baern in as the sacrifice.</p>",
  },
  {
    number: 13,
    date: "2022-06-15",
    players: FOUNDERS,
    xp: 1800,
    description: "Brendor NPCs; the life/death ritual.",
    dmNotes:
      "<p>Read backstories.</p>" +
      "<p>Cloak of Displacement — <code>https://www.dndbeyond.com/magic-items/4605-cloak-of-displacement</code> · Ring of Mind Shielding — <code>https://www.dndbeyond.com/magic-items/4725-ring-of-mind-shielding</code></p>" +
      "<h4>Brendor</h4><ul>" +
      "<li>Dworic Orcfoe — former sheriff, dwarf male, brother of Reikin Orcfoe, starts snowball fight</li>" +
      "<li>Nevil and Kithri High-Hill — rich couple gambling with you, halflings</li>" +
      "<li>Shax Ennui — former town guard, friend, involved in snowball fight and rebuilding house, female tiefling</li>" +
      "<li>Farah Van Wyk — former teacher, female human, friend?, involved in snowball fight and rebuilding house</li>" +
      "<li>Hogar Grumbash Ushat — former logger, involved in snowball fight and rebuilding house, half-orc male</li></ul>" +
      "<p>Rolls: 20 12 16 · 2 16 5 · 4 23 23 · 5 4</p>" +
      "<p>3 disadvantages for being drunk. 1 hr timer to call Reya.</p>" +
      "<h4>Baern Durthane</h4><ul><li>Baern's Bane</li><li>Baern's Pauldron</li><li>Coins: 755 pp, 692 gp, 130 sp</li></ul>" +
      "<h4>Ritual</h4><ul>" +
      "<li>Runes begin to glow white, brighter and brighter, pulsing</li><li>Roll</li>" +
      "<li>The rooms begin to shake</li>" +
      "<li>The ceiling magically disintegrates before your eyes — on one side a blistering hot day (death), on the other a moonlit night (life)</li><li>Roll</li>" +
      "<li>White energy streams into the life chamber, black into the death chamber</li><li>Roll</li></ul>" +
      "<p><b>If it goes well</b></p><ul><li>Moon glows brighter and brighter</li><li>“Hurron, promise me one thing. Promise me you will save this town. Fablan cannot do it alone. It is my life's work, and the life's work of my father and his father before him. Now it will be yours.”</li></ul>" +
      "<p><b>If it goes bad</b></p><ul><li>Black energy spreads beyond the death chamber</li><li>Roof turns brilliantly white</li><li>Flashback to Fabian's “death” scene and the death of his wife</li><li>The flames glow pure white</li><li>Find yourself in infinite white</li><li>A figure appears, a human woman. She is sowing your wounds closed with bright white thread</li><li>She doesn't move her mouth, but you hear her say “Now you must serve him … as I did”</li><li>Wake up</li></ul>",
  },
  {
    number: 14,
    date: "2022-07-06",
    players: [...minus(FOUNDERS, "Scott"), "Hank"],
    xp: 1900,
    description: "Elemental puzzle rooms. Scott out; Hank guested.",
    dmNotes:
      "<h4>Main room</h4><p>A room with a story, with several idols with open mouths. The PCs would have to redirect water into the correct idol's mouth, based on the story.</p>" +
      "<p>Indication that death has taken over.</p>" +
      "<p>Korkoth took the land; Krashandalon melted the mountain slow and flooded the land, creating the giant lake.</p>" +
      "<h4>Chambers</h4><ul>" +
      "<li><b>Air</b></li>" +
      "<li><b>Earth</b> — connection to earth (teleportation circle)</li>" +
      "<li><b>Fire</b> — torches, must light underwater</li>" +
      "<li><b>Life</b> — heals the party</li>" +
      "<li><b>Death</b> — blood of creation (god bled onto the world creating water, which created life). Must cut themselves and bleed on the ruins</li></ul>" +
      "<h4>Final</h4><p>Kraken + control weather, 3d4 days.</p>" +
      "<p><b>Final description:</b> Made it to…</p>",
  },
  {
    number: 15,
    date: "2022-07-20",
    players: minus(FOUNDERS, "Scott"),
    xp: 2000,
    description: "Kraken fight. Scott out.",
    dmNotes: "<p><b>Final description:</b> Fight kraken.</p>",
  },
  {
    number: 16,
    date: "2022-08-10",
    players: minus(FOUNDERS, "Scott"),
    xp: 2100,
    description: "Bandit fight; one bandit died. Scott out.",
    dmNotes: "<p><b>Final description:</b> Bandit fight, one bandit died.</p>",
  },
  {
    number: 17,
    date: "2022-09-07",
    players: [],
    xp: 2100,
    dmNotes:
      "<h4>To Do</h4><ul><li>Ring of Spell Storing</li><li>Dragontooth Dagger</li><li>Belt of Hill Giant Strength</li></ul>" +
      "<ul><li>Witch items</li><li>Bandit assault items</li><li>Raynar and Reya encounter</li><li>Windmill?</li></ul>",
  },
  {
    number: 18,
    date: undefined,
    players: [],
    xp: 2300,
    description:
      "Date unknown — between 2022-09-07 and 2022-11-09, most likely Wed 2022-09-21. XP total places it here.",
    dmNotes:
      "<h4>Ministers</h4><ul>" +
      "<li>Hurron — lieutenant governor — 10</li><li>Cylath — Minister of Merryment — 17</li><li>Sylora — master of coins — 22</li><li>Saia — Minister of Foreign Relations — 12</li><li>Wynrie — Minister of Culture — 14</li><li>Fireplug — General of The Monster Patrol — 7</li><li>Gronn — Sheriff — 16</li></ul>" +
      "<h4>Feast</h4><ul><li>Zook</li><li>Myria Underfoot</li><li>Tye Underfoot</li><li>Pavuu Lonehunter</li><li>Clara Sylvaranth</li></ul>" +
      "<h4>House items</h4><ul><li>Baern house items:</li><li>Reya house items:</li><li>Raynar house items:</li></ul>",
  },
  {
    number: 19,
    date: "2022-11-09",
    players: FOUNDERS,
    xp: 0,
    description: "7pm. XP awarded 0 — banked for next session.",
    dmNotes:
      "<h4>Townies</h4><ul><li>Myria Underfoot</li><li>Tye Underfoot</li><li>Pavuu Lonehunter</li><li>Clara Sylvaranth</li></ul>" +
      "<h4>Eladrin</h4><p>Morganna (summer), Azirssa (winter), and Greensong (autumn). Coven formed to gain power in the Feywild. Azirssa's husband (one of many) was Farworn.</p>" +
      "<h4>Minister boons</h4><p>Each gets an ability/spell, a proficiency, and +2 to a skill.</p><ul>" +
      "<li><b>Hurron — lieutenant governor.</b> Ability: Inspiring Leader. +2 to Persuasion</li>" +
      "<li><b>Cylath — Minister of Merriment.</b> Ability: something to beef up his minions. +2 to Performance</li>" +
      "<li><b>Sylora — master of coins.</b> +2 to Investigation</li>" +
      "<li><b>Saia — Ambassador of Moonbrook.</b> +2 to Survival</li>" +
      "<li><b>Wynrie — Lady of Lore.</b> Proficiency with 2 languages of your choice. +2 to History</li>" +
      "<li><b>Fireplug — General of The Monster Patrol.</b> Ability: Patrol Toll — ring the town bell; all allies within 500 feet get the benefits of the Alert feat for 1 minute. Proficiency with one weapon of your choice. +2 to Perception</li>" +
      "<li><b>Gronn — Sheriff of the Versant Highlands.</b> +2 to Insight</li></ul>" +
      "<h4>Feast</h4><ul><li>Zeek</li><li>Myria Underfoot</li><li>Tye Underfoot</li><li>Pavuu Lonehunter</li><li>Clara Sylvaranth</li></ul>" +
      "<h4>House items</h4><ul><li>Baern house items:</li><li>Reya house items:</li><li>Raynar house items:</li></ul>",
  },
  {
    number: 20,
    date: "2022-11-13",
    players: FOUNDERS,
    xp: 6000,
    description: "Noon. Second half of battle.",
    dmNotes: "<p><b>Final description:</b> Second half of battle.</p>",
  },
  {
    number: 21,
    date: "2022-11-30",
    players: minus(FOUNDERS, "Gaige", "Steph"),
    xp: 2000,
    description: "7pm. Town improvements. Gaige and Steph out; Andrew ~15 min late.",
    dmNotes:
      "<p>Face · Aged · Cage · Fade</p>" +
      "<h4>Town improvements</h4><ul>" +
      "<li>Scott: wall, food, fishery</li>" +
      "<li>Julie: house hunting (wizards), haunted house, Pyra, Reya (braid hair)</li>" +
      "<li>Max: graveyard, everything, cleaning</li>" +
      "<li>Alex: garden, gallows, bell tower</li>" +
      "<li>Andrew: Zook, rebuild jail</li></ul>" +
      "<p>Rolls: 19 Fireplug · 18 Cylath · 12 Wynrie · 11 Gronn · 3 Sylora</p>" +
      "<p><b>Final description:</b> Town improvements.</p>",
  },
  {
    number: 22,
    date: "2023-01-08",
    players: FOUNDERS,
    xp: 2400,
    description: "1pm. Badges introduced.",
    dmNotes:
      "<h4>Sylora fight</h4><p>Prayer Necklace of Nes de Gosh — <code>https://www.dndbeyond.com/magic-items/6106085-prayer-necklace-of-nes-de-gosh</code> · Sunny's Living Gloves — <code>https://www.dndbeyond.com/magic-items/6106798-sunnys-living-gloves</code></p>" +
      "<h4>Loot</h4><ul><li>Battle loot</li><li>Treasure map</li></ul>" +
      "<h4>Badges</h4><p>7 total. + to skill, + to toolset, + to ability.</p>" +
      "<p>Years · Gears · Cheers · Reveres</p><p>“the fi- the bandit”</p>",
  },
  {
    number: 23,
    date: "2023-01-16",
    players: FOUNDERS,
    xp: 2500,
    description:
      "2pm, MLK Day. Julie made it despite the derm appointment. Last session with XP tracking (36,200 total).",
    dmNotes:
      "<p>Fillias.</p>" +
      "<h4>Map encounter</h4><ol><li>Let the crescent moon guide your way</li><li>True north will lead you to the right path</li><li>Remember the steps you took to get here</li></ol>" +
      "<blockquote><p>I am made of all shapes, but belong in a square,<br>From the end of the steal or a basilisk's stare.<br>A grand simulacrum to pay our respect,<br>And the people of Moonbrook, I was born to protect.</p></blockquote>" +
      "<h4>Loot</h4><p>169 pp · 19,643 gp · 7,500 in rubies and sapphires · 28,833 gold equivalent · 2 diamonds · 1/3 of total loot.</p>",
  },
  {
    number: 24,
    date: "2023-02-05",
    players: FOUNDERS,
    description: "2pm. Scott late. XP tracking stops here.",
    dmNotes:
      "<h4>Random events</h4><ul>" +
      "<li>1 — imminent orc attack</li><li>2 — orc scouting party, large attack soon</li><li>3 — large monster attack</li><li>4–5 — small monster attack (no combat)</li><li>6–8 — bad weather</li><li>7 — good weather</li><li>17–18 — traveling saleswoman</li><li>19–20 — new citizen arrives</li></ul>" +
      "<h4>Prep</h4><ul><li>History book</li><li>Patrol recruits</li><li>Morden info</li><li>Mines</li><li>Clothing list</li><li>Hookup rumors?</li><li>Townhall chat</li><li>Rare metals</li><li>Food per day for town</li></ul>",
  },
  {
    number: 25,
    date: "2023-02-18",
    players: FOUNDERS,
    description: "3pm. Derek's birthday session, party after. Scott and Julie ~3:10.",
  },
  {
    number: 26,
    date: "2023-04-02",
    players: FOUNDERS,
    description: "Noon. Mine time.",
  },
  {
    number: 27,
    date: "2023-05-07",
    players: minus(FOUNDERS, "Julie"),
    description: "2pm. Gaige's last session. Julie out (POTS); Alex and Scott late.",
  },
  {
    number: 27.5,
    date: "2023-05-17",
    players: [...minus(AFTER_GAIGE, "Julie", "Steph"), "Drew"],
    description:
      "7pm. Discord-only session — no OneNote page, never numbered. Drew joined as a guest; Julie and Steph out.",
  },
  {
    number: 28,
    date: "2023-07-02",
    players: minus(AFTER_GAIGE, "Steph"),
    description: "2pm. Steph out; Julie and Scott late.",
    dmNotes:
      "<h4>Cylath's father</h4><p>Leadership “under the proper authority.”</p>" +
      "<blockquote><p>These towns, springing up like a fungus from the pooled entrails of my enemies. These fucking towns are full of little kings now. Rosy-cheeked royalty as thick as flies. Ignorant of what the cost of their easy lives is… what was paid to bring about this era of peace and prosperity.</p></blockquote>" +
      "<p>Cylath has a mind for this business. A mind for power.</p>" +
      "<p>Vog'thirath · Zov</p>" +
      "<h4>NPCs</h4><ul>" +
      "<li>Cecily Haylock — female human, 27 (100), adult, straight</li>" +
      "<li>Duergath Balderk — male hill dwarf, 102 (350), adult, straight</li></ul>" +
      "<p>Bring back baby elks.</p><p>Gruumsh · Jawar</p>",
  },
  {
    number: 29,
    date: "2023-07-22",
    players: minus(AFTER_GAIGE, "Scott"),
    description: "1pm. Scott out; Julie ~1:30.",
  },
  {
    number: 30,
    date: "2023-08-16",
    players: AFTER_GAIGE,
    description: "7pm. Scott late.",
  },
  {
    number: 31,
    date: "2023-08-27",
    players: minus(AFTER_GAIGE, "Steph"),
    description: "6pm. Merchant Prince's Villa. Steph bailed day-of; L train down.",
    dmNotes:
      "<p>The Red Hand · The Whitecloaks</p>" +
      "<h4>To do</h4><ul><li>Farm</li><li>Mansion</li><li>Update town list</li></ul>" +
      "<h4>Poison roll</h4><ul><li>01–10 — know it is poison</li><li>11–17 — eat the food right away, group dies</li><li>18–21 — orc finds the poison, but uses it for his own means</li><li>22–25 — leader eats it</li></ul>" +
      "<h4>Villa features</h4><ul><li>Portal to a different room</li><li>Secret rooms</li><li>Panic room</li><li>Magic hallway that turns you around</li></ul>" +
      "<h4>Merchant Prince's Villa</h4><ol>" +
      "<li><b>Entryway.</b> Breezy, tiled courtyard with a splashing fountain; washroom left of the entrance. The portico is always guarded by 1d4 + 1 gladiators with advantage on checks and saves against attempts to distract, bamboozle, or charm them. Two-story ceiling, sometimes open to the sky.</li>" +
      "<li><b>Sitting Area.</b> Waiting and meeting area for unknown guests. Rugs and pillows; narrow windows double as arrow slits.</li>" +
      "<li><b>Grand Hall.</b> Magnificently tiled floor flanked by two sweeping staircases to the upper floor.</li>" +
      "<li><b>Guest Rooms.</b> Three private sleeping rooms with baths, two sitting rooms, garden access.</li>" +
      "<li><b>Garden.</b> Ferns, potted palms, orchids, tropical flowers; open to the sky. Rare or poisonous plants for a horticultural prince.</li>" +
      "<li><b>Dining Room.</b> Very low table; diners relax on pillows.</li>" +
      "<li><b>Sauna.</b> In a merchant prince's home a trapped fire elemental provides round-the-clock heat.</li>" +
      "<li><b>Bath.</b> The cornerstone of a Chultan mansion; being invited in is an honor.</li>" +
      "<li><b>Kitchen.</b> Large, high-ceilinged, well ventilated. Stairs to the laundry room.</li>" +
      "<li><b>Library.</b> A character sifting a few hours who makes DC 15 Intelligence (Investigation) finds useful books of Chultan lore among the romances.</li>" +
      "<li><b>Family Rooms.</b> Close family live here; pillows and tiger-skin rugs.</li>" +
      "<li><b>Master Suite.</b> The most opulent room; private bath and walk-in closet. Treasure: two rolls on Gems or Art Objects (Hoard CR 0–4); jewelry 50% in a locked box, DC 15 Dexterity with thieves' tools.</li>" +
      "<li><b>Guard Rooms.</b> Set among the family rooms; 1d4 + 1 fanatically loyal gladiators.</li>" +
      "<li><b>Laundry Room.</b> Washed daily, fanned dry in the humid air.</li>" +
      "<li><b>Servants' Quarters.</b> Isolated from the family areas.</li>" +
      "<li><b>Rain Traps.</b> Every room has at minimum a small basin with running water.</li></ol>" +
      "<p>Source: Port Nyanzaru — Merchant Prince's Villa — <code>https://www.dndbeyond.com/sources/toa/port-nyanzaru#MerchantPrincesVilla</code></p>",
  },
  {
    number: 31.5,
    date: "2023-09-04",
    players: minus(AFTER_GAIGE, "Steph"),
    description:
      "Noon, Labor Day. Discord-only session — no OneNote page, never numbered. BBQ mid-session; Steph in Ireland.",
  },
  {
    number: 32,
    date: "2023-09-06",
    players: minus(AFTER_GAIGE, "Steph"),
    description: "7pm. Feywild riddles, Schools of Firebloods. Steph out.",
    dmNotes:
      "<h4>Schools of Firebloods</h4><p>Leader: Fire of Fires.</p><ol>" +
      "<li>The Brotherhood of Elemental Fire — dead</li><li>The Brotherhood of Ethereal Fire</li><li>The Brotherhood of Dragon Fire — dead</li><li>The Brotherhood of Wildfire</li></ol>" +
      "<h4>Spells to include</h4><ol><li>Absorb Elements</li><li>Fire Shield</li><li>Fire Storm</li><li>Wall of Fire</li><li>Immolation</li><li>Illusory Dragon</li><li>Sunbeam</li><li>Dragon's Breath</li></ol>" +
      "<h4>Feywild riddles</h4><ol>" +
      "<li>When brightest, I am darkest. When darkest, I am gone. When I am gone forever, so are you.</li>" +
      "<li>You answer me, but I never ask you a question.</li>" +
      "<li>The more you take, the more you leave behind.</li>" +
      "<li>The maker doesn't want it. The buyer doesn't need it. The user doesn't realize they are using it.</li>" +
      "<li>You see me in a brook, but I never get wet.</li></ol>" +
      "<h4>Royal / Anti-Fireblood</h4><ol><li>Sylora</li><li>Leshanna</li><li>Zanny</li><li>Daisy</li><li>Jed and Zaralynn Grady</li></ol>",
  },
  {
    number: 33,
    date: "2023-09-12",
    players: minus(AFTER_GAIGE, "Steph"),
    description: "6pm. Andrew's last session as a regular. Steph out.",
  },
  {
    number: 34,
    date: "2023-11-05",
    players: AFTER_ANDREW,
    description: "12:30pm. Marathon delays.",
  },
  {
    number: 35,
    date: "2023-11-19",
    players: [...minus(AFTER_ANDREW, "Steph"), "Andrew"],
    description: "4:30pm. Steph out; Andrew visiting. Karaoke after.",
  },
  {
    number: 36,
    date: "2024-01-20",
    players: AFTER_ANDREW,
    description: "Noon. Astral Plane; the prophecy poem.",
    dmNotes:
      "<p>Vote on Gaige.</p>" +
      "<p>The Astral Plane is the realm of thought and dream, where visitors travel as disembodied souls to reach the planes of the divine and demonic. It is a great, silvery sea, the same above and below, with swirling wisps of white and gray streaking among motes of light resembling distant stars. Erratic whirlpools of color flicker in midair like spinning coins. Occasional bits of solid matter can be found here, but most of the Astral Plane is an endless, open domain.</p>" +
      "<blockquote><p>Tales woven new from life and death,<br>In dreams where silent sleep retires,<br>They drank the wine of river Lethe,<br>Incurred the wrath of dragon's breath,<br>And cursed their kin to pain and pyre</p>" +
      "<p>But once the ash meets sky and ground,<br>Beneath the moon's pale, ghostly spire.<br>A future forged, and balance found<br>The hidden caliph claimed and crowned,<br>A new age begins, when water meets fire.</p></blockquote>",
  },
  {
    number: 37,
    date: "2024-02-25",
    players: [...minus(AFTER_ANDREW, "Scott", "Steph"), "Andrew"],
    description: "Noon. Scott and Steph out; Andrew visiting.",
  },
  {
    number: 38,
    date: "2024-03-31",
    players: AFTER_ANDREW,
    description: "1pm, Easter. Egg encounter, new townsfolk roster.",
    dmNotes:
      "<h4>To do</h4><ul><li>Egg encounter design</li><li>Assorted items for eggs</li><li>Town aftermath</li><li>Lore writeups</li><li>Rake</li><li>Hide eggs</li></ul>" +
      "<p>Crown of the Sea Queen — <code>https://www.dndbeyond.com/magic-items/8251839-crown-of-the-sea-queen</code></p>" +
      "<h4>Egg loot</h4><ol>" +
      "<li>Nature's Mantle</li><li>Robe of Eyes</li><li>Arrow of Many Targets (homebrew)</li><li>Insignia of Claws</li><li>Amulet of Health</li><li>Atlas of Endless Horizons</li><li>Chime of Opening</li><li>Arcane Oil</li><li>Potion of Giant Size</li>" +
      "<li>Thought strand × 6 (10–15)</li><li>Coins × 5 (16–20)</li><li>Potion of Superior Healing × 2 (21–22)</li><li>Potion of Supreme Healing (23)</li><li>Potion of Invulnerability (24)</li><li>Ring of Regeneration (25)</li><li>Ring of Fire Resistance (26)</li><li>Ring of Telekinesis (27)</li><li>Ring of Feather Falling (28)</li><li>Shattered amulet × 11 (29–39)</li></ol>" +
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
    number: 39,
    date: "2024-06-02",
    players: minus(AFTER_ANDREW, "Scott"),
    description: "2pm. Scott out.",
  },
  {
    number: 40,
    date: "2024-06-09",
    players: minus(AFTER_ANDREW, "Scott"),
    description: "1pm. Andraste; Niobe the fortune teller. Scott out.",
    dmNotes:
      "<h4>Andraste — modiste</h4><p>Olive skin. Gleaming fabric. Shapeshifting.</p>" +
      "<h4>Niobe — fortune teller</h4><ul><li>Cylath —</li><li>Fireplug —</li><li>Saia —</li><li>Wynrie — Will I ever meet my parents? Did they love me?</li></ul>" +
      "<p>Robe of Lies.</p><p>5 prisoners.</p>",
  },
  {
    number: 41,
    date: "2024-07-21",
    players: AFTER_ANDREW,
    description: "1pm. 22 enemies staged. Andrew couldn't visit.",
    dmNotes:
      "<h4>Enemies</h4><ul><li>2 griffon riders</li><li>Hill giant</li><li>4 worgs</li><li>16 unmounted</li><li>22 total</li></ul>" +
      "<h4>To do</h4><ul><li>Map</li><li>Bean options</li></ul>",
  },
  {
    number: 42,
    date: "2024-10-12",
    players: [...AFTER_ANDREW, "Andrew"],
    description: "5:30pm. Orc Weekend day 1. Earth Temple abilities.",
    dmNotes:
      "<h4>Earth Temple abilities</h4><ol>" +
      "<li>Earthquake — <code>https://www.dndbeyond.com/spells/2619160-earthquake</code></li>" +
      "<li>Transport via Plants — <code>https://www.dndbeyond.com/spells/2619196-transport-via-plants</code></li>" +
      "<li>Mirage Arcane — <code>https://www.dndbeyond.com/spells/2619040-mirage-arcane</code></li>" +
      "<li>Fertility: revive the fleur de vie</li>" +
      "<li>Item that gives spells based on Circle of the Land spells, and a special wildshape</li></ol>" +
      "<p>Goth ro blades — Lord of Blades.</p>",
  },
  {
    number: 43,
    date: "2024-10-13",
    players: [...AFTER_ANDREW, "Andrew"],
    description: "~2pm. Orc Weekend day 2 — battle, part 1.",
    dmNotes: "<p>Battle pt 1.</p>",
  },
  {
    number: 44,
    date: "2024-10-14",
    players: [],
    description:
      "“Battle pt 2.” Conflict: Discord planned a two-day Orc Weekend only and is silent on 10/14; both pages 43 and 44 were created mid-session on 10/13. Possibly an unused stub for a battle finished on Sunday.",
    dmNotes: "<p>Battle pt 2.</p>",
  },
  {
    number: 45,
    date: "2024-12-14",
    players: minus(AFTER_ANDREW, "Steph"),
    xp: 0,
    description: "6pm. Trials of Gosh. XP reset to 0. Steph out (fever).",
    dmNotes:
      "<h4>Trials of Gosh</h4><ul>" +
      "<li><b>Cultivate thy Faith</b> — dead orc bodies, can “fertilize the soil”</li>" +
      "<li><b>Sow a new Path</b> — prove your devotion; plant an adequate item into the ground and roots open a passage</li>" +
      "<li><b>Grow thy Zeal</b> — plant growth to create vines down the crevasse</li>" +
      "<li><b>Nurture thy Lord</b> — heal the dying tree</li>" +
      "<li><b>Reap thy Rewards</b> — what is her reward?</li></ul>" +
      "<h4>Tenets</h4><ol><li>Grow with Patience and Purpose</li><li>Root Thyself in Faith (devotion)</li><li>Nurture thy Earth, Nurture thy Self</li></ol>" +
      "<h4>Verses</h4><ul>" +
      "<li><b>Cultivate thy Faith:</b> “Where the earth lies barren and the fallen decay, awaken the soil to find the right way”</li>" +
      "<li><b>Sow a new Path:</b> “sow a token of the past to start anew, but unworthy a seed makes many the few”</li>" +
      "<li><b>Grow thy Zeal:</b> “When no way forward can be found, embrace your abilities of boundless ground.”</li>" +
      "<li><b>Nurture thy Lord:</b> “The great tree falters, its lifeblood fades; revive the bringer of life, and the glory of gosh cascades.”</li>" +
      "<li><b>Reap thy Rewards:</b> “The faithful shall find their harvest; her givings awash, so blessed are the devoted to the goddess gosh”</li></ul>" +
      "<p>The tenets of faith will show you the path, but falter in faith and incur the lord's wrath.</p>",
  },
  {
    number: 46,
    date: "2025-03-16",
    players: AFTER_ANDREW,
    description:
      "1pm. Alex left ~4pm. OneNote page missing; number inferred from the session 48 page.",
  },
  {
    number: 46.5,
    date: "2025-04-20",
    players: minus(AFTER_ANDREW, "Steph"),
    description:
      "~2pm. Informal “session 0” refresh — never numbered, Discord only. Steph out.",
  },
  {
    number: 47,
    date: "2025-05-03",
    players: [...minus(AFTER_ANDREW, "Steph"), "Andrew"],
    description:
      "2pm. Derek winged it. Steph out; Andrew visiting. OneNote page missing; number inferred.",
  },
  {
    number: 48,
    date: "2025-06-01",
    players: minus(AFTER_ANDREW, "Steph"),
    description:
      "1pm — BBQ, then game. Death Temple, catacombs, Kelemvor. Page written 2025-05-26 for the Memorial Day game that slipped a week; date from Discord.",
    dmNotes:
      "<h4>Puzzle ideas</h4><ul>" +
      "<li>Catacombs — a secret passage is inside a tomb; only when completely entombed does the bottom open to a level below</li>" +
      "<li>Gravestone — a game of “Guess Who” to determine which grave is the correct one</li>" +
      "<li>To enter the final chamber, one must “pass through death” itself — must kill themselves to see the other side</li></ul>" +
      "<h4>Catacombs</h4><ol>" +
      "<li>Each night we lie in gentle graves, rehearsing the stillness that waits beyond waking.</li>" +
      "<li>In death we do not vanish, but drift into the stillness between heartbeats, where even dreams dare not stir.</li>" +
      "<li>There is no peace until returned to the ground, for out of it you were taken. Dust you are, and to dust you will return.</li>" +
      "<li>Death does not count. I have only slipped away into the next room. Nothing has happened.</li>" +
      "<li>Do not fear this final repose. The quiet is kind where pain is forgotten.</li>" +
      "<li>Once I dreamt of death, and now it dreams of me.</li></ol>" +
      "<blockquote><p>There is but one path, one destination: to sink into the sands of time. Do not waste a whisper delaying death's cold kiss. The sands are ceaseless, and the breath you borrowed must be paid in silence.</p></blockquote>" +
      "<p>Write about an evil entity that sought eternal life.</p>" +
      "<p><b>The adversary of life is not death, but life eternal.</b></p>" +
      "<h4>Kelemvor</h4>" +
      "<p>Kelemvor, formerly Kelemvor Lyonsbane, also known as the Lord of the Dead and Judge of the Damned, is the god of death and the dead, and master of the Crystal Spire in the Fugue Plane.</p>" +
      "<p>Fair yet cold, Kelemvor is the god of death and the dead — the most recent deity to hold this position, following in the footsteps of Jergal, Myrkul, and Cyric. Unlike these other deities, whose rule as gods of the dead made the afterlife an uncertain and fearful thing, Kelemvor promoted that death was a natural part of life and should not be feared as long as it was understood.</p>" +
      "<p>Domains: Death, Grave. Alignment: Lawful Neutral.</p>",
  },
  {
    number: 49,
    date: "2025-09-14",
    players: WITH_CAPRICA,
    description: "5pm. Caprica's first session. Moved from Fri 9/12.",
  },
  {
    number: 50,
    date: "2025-11-23",
    players: minus(WITH_CAPRICA, "Scott"),
    description: "Noon, Julie's birthday. Scott likely out; Alex left ~5:30.",
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
  let created = 0;
  let skipped = 0;
  let campaignName = null;

  for (let at = 0; at < MOONBROOK_SESSIONS.length; at += BATCH) {
    const chunk = MOONBROOK_SESSIONS.slice(at, at + BATCH);
    const args = JSON.stringify({ campaignId, records: chunk });
    const run = spawnSync(
      "npx",
      ["convex", "run", "sessions:importRecords", args],
      { encoding: "utf8" }
    );
    if (run.status !== 0) {
      console.error(run.stdout ?? "");
      console.error(run.stderr ?? "");
      console.error(
        `\nFailed on the batch starting at session ${chunk[0].number}. ` +
          "Nothing in this batch was written; everything before it was. " +
          "Fix the error and run the script again — already-imported " +
          "sessions are skipped, not duplicated."
      );
      process.exit(1);
    }
    const m = /\{[^{}]*"created"[^{}]*\}/.exec(run.stdout ?? "");
    if (m) {
      const out = JSON.parse(m[0]);
      created += out.created;
      skipped += out.skipped;
      campaignName = out.campaign;
    }
    console.log(
      `sessions ${chunk[0].number}–${chunk[chunk.length - 1].number}: done`
    );
  }

  console.log(
    `\n${campaignName ?? "Campaign"}: ${created} session${
      created === 1 ? "" : "s"
    } created, ${skipped} already there and left alone.`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
