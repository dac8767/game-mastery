/**
 * Guard 7 — unit tests for the pure helpers.
 *
 * The Notebook handoff is explicit that the tree operations are where
 * the bugs live and the cheapest thing to cover, so they were written
 * free of React and Convex specifically to be callable from here.
 *
 * The module is TypeScript, so it is compiled to a temp directory and
 * imported. That is deterministic across Node versions, unlike relying
 * on the runtime's type-stripping flag, which differs between the Node
 * on a dev machine and the Node in CI.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT, appPath, read } from "./lib.mjs";

function compile(relPath) {
  const out = mkdtempSync(join(tmpdir(), "gm-unit-"));
  const r = spawnSync(
    "npx",
    [
      "tsc",
      relPath,
      "--outDir",
      out,
      "--module",
      "es2022",
      "--target",
      "es2022",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
    ],
    { cwd: APP_ROOT, encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(
      `could not compile ${relPath}:\n${(r.stdout ?? "") + (r.stderr ?? "")}`
    );
  }
  // The app is CommonJS by default, so mark the output as ESM.
  writeFileSync(join(out, "package.json"), '{"type":"module"}');
  return out;
}

export const unit = {
  name: "unit",
  description: "pure notebook helpers behave under edge cases",
  async run() {
    const problems = [];
    const check = (label, cond) => {
      if (!cond) problems.push(label);
    };

    const out = compile("components/notebookTree.ts");
    const nb = await import(
      pathToFileURL(join(out, "notebookTree.js")).href
    );

    // ---- buildTree -------------------------------------------------
    const node = (id, kind, parentId, order = 0, extra = {}) => ({
      _id: id,
      kind,
      title: id,
      parentId,
      order,
      ...extra,
    });

    const nested = nb.buildTree([
      node("f", "section", null, 0),
      node("p1", "page", "f", 1),
      node("p2", "page", "f", 0),
    ]);
    check(
      "buildTree nests pages under their folder",
      nested.length === 1 && nested[0].children.length === 2
    );
    check(
      "buildTree sorts siblings by order",
      nested[0]?.children[0]?._id === "p2"
    );

    // An orphan must surface at the root, not vanish.
    const orphaned = nb.buildTree([node("p", "page", "missing-folder")]);
    check(
      "buildTree promotes an orphan instead of dropping it",
      orphaned.length === 1 && orphaned[0]._id === "p"
    );

    // A parent cycle must not hang or swallow the branch.
    const cyclic = nb.buildTree([
      node("a", "section", "b"),
      node("b", "section", "a"),
    ]);
    check("buildTree survives a parent cycle", cyclic.length === 2);

    // A page can never hold children, whatever a stale row claims.
    const badParent = nb.buildTree([
      node("pg", "page", null),
      node("kid", "page", "pg"),
    ]);
    check(
      "buildTree refuses to nest under a page",
      badParent.length === 2
    );

    // ---- isAncestor ------------------------------------------------
    const chain = [
      node("root", "section", null),
      node("mid", "section", "root"),
      node("leaf", "page", "mid"),
    ];
    check("isAncestor: self counts", nb.isAncestor(chain, "root", "root"));
    check("isAncestor: direct parent", nb.isAncestor(chain, "mid", "leaf"));
    check("isAncestor: grandparent", nb.isAncestor(chain, "root", "leaf"));
    check(
      "isAncestor: unrelated is false",
      !nb.isAncestor(chain, "leaf", "root")
    );
    check(
      "isAncestor: terminates on a cycle",
      nb.isAncestor(
        [node("x", "section", "y"), node("y", "section", "x")],
        "zzz",
        "x"
      ) === false
    );

    // ---- visibleNodes / firstPageId --------------------------------
    const collapsedTree = nb.buildTree([
      node("f", "section", null, 0, { collapsed: true }),
      node("hidden", "page", "f", 0),
      node("shown", "page", null, 1),
    ]);
    const vis = nb.visibleNodes(collapsedTree).map((v) => v.node._id);
    check("visibleNodes hides a collapsed folder's contents", !vis.includes("hidden"));
    check("visibleNodes keeps the folder itself", vis.includes("f"));
    check(
      "firstPageId finds a page inside a collapsed folder",
      nb.firstPageId(collapsedTree) === "hidden"
    );

    // ---- tables ----------------------------------------------------
    const t = nb.emptyTable(3, 3);
    check("emptyTable shape", t.rows.length === 3 && t.rows[0].length === 3);

    const added = nb.tableInsertRow(t, 1);
    check(
      "tableInsertRow adds a row and its height",
      added.rows.length === 4 && added.rowHeights.length === 4
    );
    const wider = nb.tableInsertCol(t, 0);
    check(
      "tableInsertCol widens every row",
      wider.rows.every((r) => r.length === 4) && wider.colWidths.length === 4
    );
    check(
      "tableDeleteRow keeps the last row",
      nb.tableDeleteRow(nb.emptyTable(1, 2), 0).rows.length === 1
    );
    check(
      "tableDeleteCol keeps the last column",
      nb.tableDeleteCol(nb.emptyTable(2, 1), 0).rows[0].length === 1
    );

    const sortable = {
      rows: [
        ["Name", "Age"],
        ["Zed", "30"],
        ["Amy", "9"],
      ],
      colWidths: [100, 100],
      rowHeights: [30, 31, 32],
    };
    const sorted = nb.tableSort(sortable, 0, true);
    check("tableSort keeps the header first", sorted.rows[0][0] === "Name");
    check("tableSort orders the body", sorted.rows[1][0] === "Amy");
    check(
      "tableSort carries row heights with their rows",
      sorted.rowHeights[1] === 32
    );
    const numeric = nb.tableSort(sortable, 1, true);
    check(
      "tableSort compares numbers numerically, not as text",
      numeric.rows[1][1] === "9"
    );
    check("tableIsEmpty on a fresh grid", nb.tableIsEmpty(nb.emptyTable(2, 2)));

    // ---- images ----------------------------------------------------
    const turned = nb.rotatedImagePatch({ w: 300, h: 100, rotate: 0 }, 90);
    check(
      "rotatedImagePatch swaps the box on a quarter turn",
      turned.w === 100 && turned.h === 300 && turned.rotate === 90
    );
    const halfTurn = nb.rotatedImagePatch({ w: 300, h: 100, rotate: 0 }, 180);
    check(
      "rotatedImagePatch keeps the box on a half turn",
      halfTurn.w === 300 && halfTurn.h === 100
    );
    check(
      "rotatedImagePatch normalizes below zero",
      nb.rotatedImagePatch({ w: 10, h: 10, rotate: 0 }, -90).rotate === 270
    );

    // ---- emptiness -------------------------------------------------
    // Drives the always-visible border on an empty box. contentEditable
    // never leaves a field truly empty, so the naive `html === ""` test
    // reports "has content" for exactly the box that needs its border.
    check("htmlIsBlank: undefined", nb.htmlIsBlank(undefined));
    check("htmlIsBlank: empty string", nb.htmlIsBlank(""));
    check("htmlIsBlank: a stray <br>", nb.htmlIsBlank("<br>"));
    check("htmlIsBlank: an empty div", nb.htmlIsBlank("<div><br></div>"));
    check("htmlIsBlank: &nbsp;", nb.htmlIsBlank("&nbsp;"));
    check(
      "htmlIsBlank: styled-but-empty markup",
      nb.htmlIsBlank('<span style="font-size:18pt"></span>')
    );
    check("htmlIsBlank: real text is not blank", !nb.htmlIsBlank("<b>hi</b>"));

    check(
      "boxIsEmpty: a text box with only a <br>",
      nb.boxIsEmpty({ type: "text", html: "<div><br></div>" })
    );
    check(
      "boxIsEmpty: a text box with words",
      !nb.boxIsEmpty({ type: "text", html: "<p>Sir Wren</p>" })
    );
    check(
      "boxIsEmpty: an image with no source",
      nb.boxIsEmpty({ type: "image", src: null })
    );
    check(
      "boxIsEmpty: an image counts as filled even with blank html",
      !nb.boxIsEmpty({ type: "image", src: "https://x/y.png", html: "" })
    );
    check(
      "boxIsEmpty: a fresh table",
      nb.boxIsEmpty({ type: "table", rows: [["", ""], ["", ""]] })
    );
    check(
      "boxIsEmpty: a table with one filled cell",
      !nb.boxIsEmpty({ type: "table", rows: [["", "x"], ["", ""]] })
    );

    // ---- the format toolbar's command names ------------------------
    // Every button names its command by string. Rename a key in EXEC and
    // the button keeps rendering and silently formats nothing, which
    // reads as a broken browser rather than a broken lookup.
    const fmtOut = compile("components/notebookFormat.ts");
    const fmt = await import(
      pathToFileURL(join(fmtOut, "notebookFormat.js")).href
    );

    // JSX props, not object literals: `cmd="bold"`, not `cmd: "bold"`.
    const barSrc = read("components", "NotebookFormatBar.tsx");
    const used = [...barSrc.matchAll(/\bcmd="([^"]+)"/g)].map((m) => m[1]);
    if (used.length === 0) {
      throw new Error("found no format buttons in NotebookFormatBar.tsx");
    }
    for (const key of used) {
      check(
        `NotebookFormatBar uses cmd "${key}", which EXEC does not define`,
        typeof fmt.execName(key) === "string"
      );
    }
    check(
      "execName rejects an unknown command",
      fmt.execName("definitelyNotACommand") === null
    );
    check(
      "the font-size ladder is sorted and free of duplicates",
      fmt.FONT_SIZES.every((s, i, a) => i === 0 || s > a[i - 1])
    );
    check(
      "BOX_ATTR is the attribute NotebookTool actually sets",
      read("components", "NotebookTool.tsx").includes(`${fmt.BOX_ATTR}=`)
    );

    // ---- the ribbon's grammar --------------------------------------
    // This is the first thing the ribbon handoff says to get right, and
    // the reason ribbonTokens.ts imports nothing: the parser has to be
    // TOTAL — every input, including a hand-corrupted one, must yield a
    // model rather than throwing — and the round-trip has to hold.
    const ribOut = compile("components/ribbonTokens.ts");
    const rib = await import(pathToFileURL(join(ribOut, "ribbonTokens.js")).href);

    const REG = {
      builtins: ["undo", "redo", "customize"],
      permanent: ["customize"],
      tools: ["npcs", "chat"],
      commands: ["feedback"],
    };

    // Canonical form is what round-trips: ids are re-minted on
    // serialize, so the property is that parsing a serialized model
    // gives the same model back.
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const roundTrips = (tokens) => {
      const once = rib.parseRibbon(tokens);
      return eq(rib.parseRibbon(rib.serializeRibbon(once)), once);
    };

    const sample = [
      "b:undo",
      "2!d:sec-1",
      "st:Tools",
      "t:npcs",
      "r:row-1",
      "t:chat",
      "a:split-1",
      "c:feedback",
      "b:customize",
    ];
    check("parseRibbon round-trips a normal bar", roundTrips(sample));
    check(
      "serializeRibbon is idempotent through parse",
      eq(
        rib.serializeRibbon(rib.parseRibbon(rib.serializeRibbon(rib.parseRibbon(sample)))),
        rib.serializeRibbon(rib.parseRibbon(sample))
      )
    );

    // ---- malformed inputs, one class each --------------------------
    check("parseRibbon of an empty array", rib.parseRibbon([]).sections.length === 1);
    check(
      "a leading row break puts everything on the bottom row",
      rib.parseRibbon(["r:x", "b:undo"]).sections[0].bottom.length === 1
    );
    check(
      "a second row break in one section merges into the first",
      rib.parseRibbon(["b:undo", "r:a", "b:redo", "r:b", "c:feedback"])
        .sections[0].bottom.length === 2
    );
    check(
      "rl: anywhere in a section draws the line",
      rib.parseRibbon(["b:undo", "r:a", "b:redo", "rl:b"]).sections[0].breakLine
    );
    const twoSplits = rib.parseRibbon(["b:undo", "a:1", "b:redo", "a:2", "c:feedback"]);
    check(
      "a second alignment split acts as a plain boundary",
      twoSplits.splitAt === 1 && twoSplits.sections.length === 3
    );
    check(
      "a title with no section after it still round-trips",
      roundTrips(["b:undo", "2!d:x", "st:Empty"])
    );
    check(
      "an empty title survives — defined means present",
      rib.parseRibbon(["st:"]).sections[0].title === ""
    );
    check(
      "nd: opens a section that paints no line",
      rib.parseRibbon(["b:undo", "nd:x", "b:redo"]).sections[1].noSepBefore === true
    );

    // Deterministic fuzz. A seeded generator rather than Math.random, so
    // a failure here is reproducible instead of a story about a build
    // that once went red.
    const ALPHABET = [
      "b:undo", "b:redo", "b:customize", "b:gone", "t:npcs", "t:chat",
      "t:missing", "c:feedback", "d:1", "2!d:2", "nd:3", "r:4", "rl:5",
      "a:6", "st:", "st:Tools", "s:7", "s:8:40", "2!b:undo", "big!b:redo",
      "", "junk",
    ];
    let seed = 20260818;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    let totalOk = true;
    let fuzzRoundTrip = true;
    let normIdempotent = true;
    let normKeepsPermanent = true;
    let normOneSplit = true;

    for (let i = 0; i < 400; i++) {
      const len = Math.floor(rnd() * 12);
      const toks = Array.from(
        { length: len },
        () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]
      );
      try {
        if (!roundTrips(toks)) fuzzRoundTrip = false;
        const once = rib.normalizeRibbon(toks, REG);
        const twice = rib.normalizeRibbon(once, REG);
        if (!eq(once, twice)) normIdempotent = false;
        if (!once.some((t) => rib.stripTall(t) === "b:customize")) {
          normKeepsPermanent = false;
        }
        if (once.filter((t) => t.startsWith("a:")).length > 1) {
          normOneSplit = false;
        }
      } catch {
        totalOk = false;
      }
    }
    check("parseRibbon and normalizeRibbon never throw (400 fuzzed inputs)", totalOk);
    check("parseRibbon round-trips every fuzzed input", fuzzRoundTrip);
    check("normalizeRibbon is idempotent", normIdempotent);
    check("normalizeRibbon always restores the permanent item", normKeepsPermanent);
    check("normalizeRibbon leaves at most one alignment split", normOneSplit);

    // ---- normalize, one behaviour each -----------------------------
    check(
      "normalizeRibbon discards a builtin whose control is gone",
      !rib.normalizeRibbon(["b:gone", "b:undo"], REG).includes("b:gone")
    );
    check(
      "normalizeRibbon discards a tool whose screen is gone",
      !rib.normalizeRibbon(["t:missing"], REG).includes("t:missing")
    );
    check(
      "normalizeRibbon dedups a repeated control",
      rib.normalizeRibbon(["b:undo", "b:undo"], REG).filter((t) => t === "b:undo")
        .length === 1
    );
    check(
      "normalizeRibbon strips the tall flag off anything but a divider",
      rib.normalizeRibbon(["2!b:undo"], REG).includes("b:undo")
    );
    check(
      "normalizeRibbon keeps the tall flag on a section divider",
      rib.normalizeRibbon(["2!d:x"], REG).includes("2!d:x")
    );
    check(
      "normalizeRibbon of undefined still yields the permanent item",
      eq(rib.normalizeRibbon(undefined, REG), ["b:customize"])
    );
    check(
      "an emptied toolbar stays empty apart from what cannot be lost",
      eq(rib.normalizeRibbon([], REG), ["b:customize"])
    );

    // ---- spacers ---------------------------------------------------
    check("spacerWidth reads an explicit width", rib.spacerWidth("s:1:40") === 40);
    check("spacerWidth of a bare spacer is null", rib.spacerWidth("s:1") === null);
    check("spacerWidth of a non-spacer is null", rib.spacerWidth("b:undo") === null);
    check(
      "withSpacerWidth keeps the id",
      rib.withSpacerWidth("s:abc", 24) === "s:abc:24"
    );
    check(
      "withSpacerWidth clears back to auto",
      rib.withSpacerWidth("s:abc:24", null) === "s:abc"
    );
    check(
      "withSpacerWidth refuses to touch a non-spacer",
      rib.withSpacerWidth("b:undo", 24) === "b:undo"
    );

    check("isStructural: a divider", rib.isStructural("2!d:1"));
    check("isStructural: a row break", rib.isStructural("r:1"));
    check("isStructural: a title", rib.isStructural("st:Tools"));
    check("isStructural: a control is not", !rib.isStructural("b:undo"));

    // ---- the campaign calendar -------------------------------------
    // A custom calendar is date arithmetic with none of the constants
    // you know by heart, so every off-by-one here is invisible until
    // someone notices the festival landed on the wrong weekday.
    const calOut = compile("components/calendarModel.ts");
    const cal = await import(
      pathToFileURL(join(calOut, "calendarModel.js")).href
    );

    const D = cal.DEFAULT_CALENDAR;

    // reconcile: the counts are the authority, names follow.
    check(
      "reconcile is idempotent",
      eq(cal.reconcile(cal.reconcile(D)), cal.reconcile(D))
    );
    const widened = cal.reconcile({ ...D, daysPerWeek: 9 });
    check(
      "widening the week pads the day names",
      widened.dayNames.length === 9 && widened.dayNames[8] === "Day 9"
    );
    check(
      "widening keeps the names already typed",
      widened.dayNames[0] === "Sunday"
    );
    const narrowed = cal.reconcile({ ...D, daysPerWeek: 3 });
    check(
      "narrowing the week truncates the day names",
      narrowed.dayNames.length === 3 && narrowed.dayNames[2] === "Tuesday"
    );
    check(
      "a blank name is replaced rather than left empty",
      cal.reconcile({ ...D, dayNames: ["", "Monday", "  ", "W", "T", "F", "S"] })
        .dayNames[0] === "Day 1"
    );
    check(
      "shrinking the month pulls the current date back inside it",
      cal.reconcile({ ...D, currentDay: 30, daysPerMonth: 10 }).currentDay === 10
    );
    check(
      "shrinking the year pulls the current month back inside it",
      cal.reconcile({ ...D, currentMonth: 11, monthsPerYear: 4 })
        .currentMonth === 3
    );
    check(
      "counts are clamped, not trusted",
      cal.reconcile({ ...D, daysPerWeek: 9999 }).daysPerWeek ===
        cal.LIMITS.daysPerWeek.max
    );
    check(
      "a non-finite count falls back rather than producing NaN",
      cal.reconcile({ ...D, daysPerMonth: Number.NaN }).daysPerMonth ===
        cal.LIMITS.daysPerMonth.min
    );

    // dayIndex/fromDayIndex must invert, including before year 1 — a
    // campaign's history is written in negative years.
    let indexRoundTrip = true;
    let weekdayInRange = true;
    let gridSound = true;
    seed = 918273;
    for (let i = 0; i < 300; i++) {
      const s = cal.reconcile({
        ...D,
        daysPerWeek: 1 + Math.floor(rnd() * 12),
        daysPerMonth: 1 + Math.floor(rnd() * 40),
        monthsPerYear: 1 + Math.floor(rnd() * 18),
      });
      const year = Math.floor(rnd() * 4000) - 2000;
      const month = Math.floor(rnd() * s.monthsPerYear);
      const day = 1 + Math.floor(rnd() * s.daysPerMonth);
      const date = { year, month, day };

      // Caught per iteration: a bad weekday makes monthGrid ask for an
      // array of negative length, and an exception here would abort the
      // guard rather than report which property broke.
      try {
        if (!eq(cal.fromDayIndex(s, cal.dayIndex(s, date)), date)) {
          indexRoundTrip = false;
        }
        const wd = cal.weekdayOf(s, date);
        if (!(wd >= 0 && wd < s.daysPerWeek)) weekdayInRange = false;

        const grid = cal.monthGrid(s, year, month);
        const flat = grid.flat();
        const days = flat.filter((c) => c !== null);
        if (
          !grid.every((w) => w.length === s.daysPerWeek) ||
          days.length !== s.daysPerMonth ||
          days[0] !== 1 ||
          days[days.length - 1] !== s.daysPerMonth ||
          flat.indexOf(1) !== cal.weekdayOf(s, { year, month, day: 1 })
        ) {
          gridSound = false;
        }
      } catch {
        gridSound = false;
      }
    }
    check("dayIndex and fromDayIndex invert (300 fuzzed calendars)", indexRoundTrip);
    check("weekdayOf never falls outside the week", weekdayInRange);
    check("monthGrid holds every day once, in full weeks, correctly offset", gridSound);

    check(
      "day 1 of year 1 is index 0",
      cal.dayIndex(D, { year: 1, month: 0, day: 1 }) === 0
    );
    check(
      "addDays crosses a month boundary",
      eq(cal.addDays(D, { year: 1, month: 0, day: 30 }, 1), {
        year: 1,
        month: 1,
        day: 1,
      })
    );
    check(
      "addDays crosses a year boundary backwards",
      eq(cal.addDays(D, { year: 2, month: 0, day: 1 }, -1), {
        year: 1,
        month: 11,
        day: 30,
      })
    );
    check(
      "addMonths rolls the year forward",
      eq(cal.addMonths(D, { year: 1, month: 11, day: 5 }, 1), {
        year: 2,
        month: 0,
        day: 5,
      })
    );
    check(
      "addMonths rolls the year back",
      eq(cal.addMonths(D, { year: 2, month: 0, day: 5 }, -1), {
        year: 1,
        month: 11,
        day: 5,
      })
    );
    check(
      "addMonths keeps the day inside a shorter month",
      cal.addMonths({ ...D, daysPerMonth: 10 }, { year: 1, month: 0, day: 30 }, 1)
        .day === 10
    );
    check(
      "formatDate names the month and the weekday",
      cal.formatDate(D, { year: 1491, month: 0, day: 1 }).startsWith(
        "1 Hammer, 1491 ("
      )
    );

    // ---- how a date reads ------------------------------------------
    // The teens are the whole reason `ordinal` is a function: 11, 12
    // and 13 end in 1, 2 and 3 and take "th" anyway. A fantasy month
    // can be a hundred days long, so 111th is reachable here in a way
    // it is not on a Gregorian calendar.
    check(
      "ordinal: the ones that follow the last digit",
      ["1st", "2nd", "3rd", "4th", "21st", "22nd", "23rd"].join() ===
        [1, 2, 3, 4, 21, 22, 23].map(cal.ordinal).join()
    );
    check(
      "ordinal: the teens are all th",
      ["11th", "12th", "13th"].join() === [11, 12, 13].map(cal.ordinal).join()
    );
    check(
      "ordinal: and so are the teens of every hundred",
      ["111th", "112th", "113th"].join() ===
        [111, 112, 113].map(cal.ordinal).join()
    );
    check(
      "ordinal: 101st, not 101th",
      cal.ordinal(101) === "101st" && cal.ordinal(100) === "100th"
    );

    const aged = cal.reconcile({
      ...D,
      ageName: "The Age of Embers",
      eraAbbr: "AE",
    });
    check(
      "the era goes inside the date",
      cal.formatLongDate(aged, { year: 744, month: 0, day: 10 }) ===
        "The 10th of Hammer, AE 744"
    );
    check(
      "and into the month heading",
      cal.formatMonthYear(aged, 744, 0) === "Hammer, AE 744"
    );
    // A campaign that never names an era must read as if the feature
    // did not exist — no stray comma, no empty prefix.
    check(
      "no era means no era in the date",
      cal.formatLongDate(D, { year: 1491, month: 0, day: 2 }) ===
        "The 2nd of Hammer, 1491" &&
        cal.formatMonthYear(D, 1491, 0) === "Hammer, 1491"
    );
    check(
      "whitespace is not an era",
      cal.formatYear(cal.reconcile({ ...D, eraAbbr: "   " }), 744) === "744"
    );
    check(
      "reconcile trims the age rather than storing the spaces",
      cal.reconcile({ ...D, ageName: "  The Age of Embers  " }).ageName ===
        "The Age of Embers"
    );

    // ---- recurring events ------------------------------------------
    // occursOn runs once per rendered cell, so it is asked the question
    // a few hundred times a page and never gets to explain itself. The
    // rules that are easy to get wrong are the two that are not plain
    // arithmetic: weekly follows daysPerWeek rather than seven, and
    // nothing recurs before the day it was put on.
    const ev = (repeat, extra = {}) => ({
      title: "Market day",
      year: 1491,
      month: 2,
      day: 10,
      repeat,
      ...extra,
    });
    const start = { year: 1491, month: 2, day: 10 };
    const on = (rule, date, extra) => cal.occursOn(D, ev(rule, extra), date);
    const after = (n) => cal.addDays(D, start, n);

    for (const rule of cal.REPEATS.map((r) => r.value)) {
      check(
        `${rule}: happens on the day it was put on`,
        on(rule, start, { intervalDays: 3 })
      );
      check(
        `${rule}: does not reach back before its start`,
        !on(rule, after(-1), { intervalDays: 3 }) &&
          !on(rule, after(-30), { intervalDays: 3 }) &&
          !on(rule, { year: 1489, month: 2, day: 10 }, { intervalDays: 3 })
      );
    }

    check("once: not the next day", !on("once", after(1)));
    check("once: not a year later", !on("once", { ...start, year: 1492 }));

    check("weekly: seven days on, in a seven-day week", on("weekly", after(7)));
    check("weekly: not six days on", !on("weekly", after(6)));
    // A whole week BEFORE the start is the day the general backward
    // cases miss: it is a clean multiple, so the modulo says yes and
    // only the on-or-after rule says no.
    check(
      "weekly: not a whole week before its start",
      !on("weekly", after(-7)) && !on("weekly", after(-70))
    );
    check("weekly: still on a hundred weeks later", on("weekly", after(700)));
    check(
      "weekly: lands on the same weekday name",
      cal.weekdayOf(D, after(7)) === cal.weekdayOf(D, start)
    );

    // The one a fixed seven would get wrong: a five-day week.
    const five = cal.reconcile({ ...D, daysPerWeek: 5 });
    const weekly5 = ev("weekly");
    check(
      "weekly: follows daysPerWeek, not seven",
      cal.occursOn(five, weekly5, cal.addDays(five, start, 5)) &&
        !cal.occursOn(five, weekly5, cal.addDays(five, start, 7))
    );

    check("monthly: same day number next month", on("monthly", after(30)));
    check(
      "monthly: same day number in a later year",
      on("monthly", { year: 1493, month: 7, day: 10 })
    );
    check(
      "monthly: not on a different day number",
      !on("monthly", { year: 1491, month: 3, day: 11 })
    );

    check(
      "yearly: same day and month, next year",
      on("yearly", { year: 1492, month: 2, day: 10 })
    );
    check(
      "yearly: not the same day in a different month",
      !on("yearly", { year: 1492, month: 3, day: 10 })
    );
    check(
      "yearly: not a different day in the same month",
      !on("yearly", { year: 1492, month: 2, day: 11 })
    );

    check(
      "everyNDays: on the interval",
      on("everyNDays", after(3), { intervalDays: 3 }) &&
        on("everyNDays", after(9), { intervalDays: 3 })
    );
    check(
      "everyNDays: off the interval",
      !on("everyNDays", after(4), { intervalDays: 3 })
    );
    check(
      "everyNDays: not a whole interval before its start",
      !on("everyNDays", after(-3), { intervalDays: 3 })
    );
    check(
      "everyNDays: an interval of one is every day",
      on("everyNDays", after(1), { intervalDays: 1 })
    );
    // A zero interval would be a modulo by zero, and a missing one a
    // modulo by NaN — both would return NaN === 0, which is false, so
    // the event would silently never appear again. It happens once.
    for (const bad of [0, -5, undefined, Number.NaN, "soon"]) {
      check(
        `everyNDays: an unreadable interval (${String(bad)}) happens once`,
        on("everyNDays", start, { intervalDays: bad }) &&
          !on("everyNDays", after(1), { intervalDays: bad }) &&
          !on("everyNDays", after(7), { intervalDays: bad })
      );
    }

    // A rule from a future version of the app, read by an older client.
    check(
      "an unknown rule degrades to happening once",
      cal.occursOn(D, { ...ev("once"), repeat: "fortnightly" }, start) &&
        !cal.occursOn(D, { ...ev("once"), repeat: "fortnightly" }, after(14))
    );

    // ---- the settings tabs -----------------------------------------
    // resolveTab is what stops the page going blank underneath someone:
    // handing over a campaign on the Game Master tab removes that tab
    // while it is the one you are looking at.
    const tabsOut = compile("components/settingsTabs.ts");
    const st = await import(
      pathToFileURL(join(tabsOut, "settingsTabs.js")).href
    );

    check("tabs are declared", st.SETTINGS_TABS.length > 0);
    check(
      "tab ids are unique",
      new Set(st.SETTINGS_TABS.map((t) => t.id)).size ===
        st.SETTINGS_TABS.length
    );
    check(
      "every tab has a label and a blurb",
      st.SETTINGS_TABS.every((t) => t.label && t.blurb)
    );
    check(
      "a player sees only the tabs that are theirs",
      st.visibleTabs(false).every((t) => !t.dmOnly)
    );
    check("a DM sees all of them", st.visibleTabs(true).length === st.SETTINGS_TABS.length);
    check(
      "a player still has somewhere to land",
      st.visibleTabs(false).length > 0
    );
    // Removed rather than renamed. The record is arranged on the record
    // now, and a Templates tab still in the list would be a second way
    // in that has to be kept honest about a layout it no longer draws.
    check(
      "the Templates tab is gone",
      !st.SETTINGS_TABS.some((t) => t.id === "templates")
    );
    check(
      "System and User replaced General, and Game Master is gone",
      st.SETTINGS_TABS.some((t) => t.id === "system") &&
        st.SETTINGS_TABS.some((t) => t.id === "user") &&
        !st.SETTINGS_TABS.some((t) => t.id === "general") &&
        !st.SETTINGS_TABS.some((t) => t.id === "gm")
    );
    check(
      "User is not DM-only — it is where everyone edits their name",
      st.SETTINGS_TABS.find((t) => t.id === "user")?.dmOnly !== true
    );
    // A tab id saved before this rename still resolves to something,
    // rather than leaving the strip pointing at a panel that is gone.
    check(
      "a stale saved tab falls back rather than blanking the page",
      st.resolveTab("gm", true) === st.SETTINGS_TABS[0].id &&
        st.resolveTab("general", false) === st.visibleTabs(false)[0].id
    );
    check(
      "the first tab is one everybody can see",
      st.SETTINGS_TABS[0].dmOnly !== true
    );

    check("a valid tab is kept", st.resolveTab("interface", false) === "interface");
    check("a DM keeps a DM tab", st.resolveTab("players", true) === "players");
    check(
      "a player asking for a DM tab is redirected, not shown a blank page",
      st.resolveTab("players", false) === st.visibleTabs(false)[0].id
    );
    check(
      "losing the DM role moves you off a DM tab",
      st.resolveTab("gm", false) === st.visibleTabs(false)[0].id
    );
    check("nonsense falls back", st.resolveTab("nope", true) === st.SETTINGS_TABS[0].id);
    check("an empty selection falls back", st.resolveTab("", false).length > 0);

    // ---- the campaign card's dates ---------------------------------
    // "Next session" is the one fact on that screen somebody acts on, so
    // being a day out is worse than showing nothing.
    const cardOut = compile("components/campaignCard.ts");
    const cc = await import(
      pathToFileURL(join(cardOut, "campaignCard.js")).href
    );

    check(
      "a stored date reads as a date",
      cc.formatCardDate("2026-09-12") === "12 Sep 2026"
    );
    check(
      "no leading zero on the day",
      cc.formatCardDate("2026-09-05") === "5 Sep 2026"
    );
    check("January", cc.formatCardDate("2026-01-01") === "1 Jan 2026");
    check("December", cc.formatCardDate("2026-12-31") === "31 Dec 2026");
    check("a bad month is left alone", cc.formatCardDate("2026-13-01") === "2026-13-01");
    check("free text passes through", cc.formatCardDate("someday") === "someday");
    check("nothing stays nothing", cc.formatCardDate(undefined) === "");
    check("a non-string", cc.formatCardDate(20260912) === "");

    // Every offered format renders, and no two render alike — an option
    // that looks identical to another is a setting that does nothing.
    const rendered = cc.DATE_FORMATS.map((f) =>
      cc.formatCardDate("2026-09-05", f.value)
    );
    check("every date format has a label", cc.DATE_FORMATS.every((f) => f.label));
    check(
      "every date format renders something",
      rendered.every((r) => typeof r === "string" && r.length > 0)
    );
    check(
      "no two formats look the same",
      new Set(rendered).size === rendered.length
    );
    check(
      "each format's example matches what it actually produces",
      cc.DATE_FORMATS.every(
        (f) => cc.formatCardDate("2026-09-05", f.value) === f.example
      )
    );
    check(
      "month first",
      cc.formatCardDate("2026-09-05", "mdy") === "Sep 5, 2026"
    );
    check(
      "numeric pads both parts",
      cc.formatCardDate("2026-09-05", "numeric") === "09/05/2026"
    );
    check(
      "year first is what was stored",
      cc.formatCardDate("2026-09-05", "iso") === "2026-09-05"
    );
    check(
      "an unknown format falls back rather than printing nothing",
      cc.formatCardDate("2026-09-05", "nonsense") === "5 Sep 2026"
    );
    check(
      "a bad date is left alone whichever format is asked for",
      cc.DATE_FORMATS.every(
        (f) => cc.formatCardDate("someday", f.value) === "someday"
      )
    );

    // The bug this exists for: `new Date("2026-09-12")` is UTC midnight,
    // which renders as the 11th anywhere west of Greenwich. Every date
    // on this card would be a day early for Derek, all year.
    const late = new Date(2026, 8, 12, 23, 30); // 11:30pm local, 12 Sep
    check(
      "a session today is today, even late at night",
      cc.daysUntil("2026-09-12", late) === 0
    );
    const early = new Date(2026, 8, 12, 0, 15); // 12:15am local
    check(
      "and in the small hours too",
      cc.daysUntil("2026-09-12", early) === 0
    );
    check(
      "tomorrow is one day away",
      cc.daysUntil("2026-09-13", late) === 1
    );
    check(
      "yesterday is minus one",
      cc.daysUntil("2026-09-11", late) === -1
    );
    check(
      "across a month boundary",
      cc.daysUntil("2026-10-01", new Date(2026, 8, 30, 12)) === 1
    );
    check(
      "across a year boundary",
      cc.daysUntil("2027-01-01", new Date(2026, 11, 31, 12)) === 1
    );
    // A date range crossing a daylight-saving change is 24-hour maths on
    // a clock that skips an hour; rounding is what keeps it whole.
    check(
      "across a daylight-saving change",
      cc.daysUntil("2026-11-08", new Date(2026, 10, 1, 12)) === 7
    );
    check("unparseable is null", cc.daysUntil("soon", late) === null);

    const at = (d) => cc.untilSession("2026-09-12", d).label;
    check("tonight", at(new Date(2026, 8, 12, 18)) === "— tonight");
    check("tomorrow", at(new Date(2026, 8, 11, 18)) === "— tomorrow");
    check("this week", at(new Date(2026, 8, 9, 18)) === "— in 3 days");
    check("next week", at(new Date(2026, 8, 2, 18)) === "— next week");
    check("further out", at(new Date(2026, 7, 12, 18)) === "— in 4 weeks");
    check("yesterday", at(new Date(2026, 8, 13, 18)) === "— yesterday");
    check("a while ago", at(new Date(2026, 8, 20, 18)) === "— 8 days ago");
    check(
      "a past session is marked overdue",
      cc.untilSession("2026-09-12", new Date(2026, 8, 20)).overdue === true
    );
    check(
      "tonight is not overdue",
      cc.untilSession("2026-09-12", new Date(2026, 8, 12, 23)).overdue === false
    );
    check(
      "no date says nothing rather than guessing",
      cc.untilSession(undefined).label === "" &&
        cc.untilSession(undefined).overdue === false
    );

    // ---- the NPC record's arrangement ------------------------------
    // arrange decides what an opened NPC looks like. The property that
    // matters is that it never LOSES a field: a column added to
    // npcColumns and not filed into a section must still be editable,
    // or it silently stops existing for every NPC in the campaign.
    const secOut = compile("components/npcSections.ts");
    const sec = await import(
      pathToFileURL(join(secOut, "npcSections.js")).href
    );

    const allSectionKeys = sec.NPC_SECTIONS.flatMap((s) => s.keys);

    check(
      "every section has an id, a title, and at least one field",
      sec.NPC_SECTIONS.every(
        (s) => s.id && s.title && Array.isArray(s.keys) && s.keys.length > 0
      )
    );
    check(
      "section ids are unique",
      new Set(sec.NPC_SECTIONS.map((s) => s.id)).size ===
        sec.NPC_SECTIONS.length
    );
    check(
      "no field is filed in two sections",
      new Set(allSectionKeys).size === allSectionKeys.length
    );
    check(
      "the header's fields are not repeated in a section",
      sec.HEADER_KEYS.every((k) => !allSectionKeys.includes(k))
    );

    const arranged = sec.arrange(allSectionKeys);
    check(
      "arrange keeps every field it is given",
      arranged.flatMap((s) => s.keys).sort().join() ===
        allSectionKeys.slice().sort().join()
    );
    check(
      "arrange holds the written order, not the caller's",
      arranged.map((s) => s.id).join() ===
        sec.NPC_SECTIONS.map((s) => s.id).join()
    );
    check(
      "arrange is unmoved by the order it is asked in",
      sec
        .arrange(allSectionKeys.slice().reverse())
        .flatMap((s) => s.keys)
        .join() === arranged.flatMap((s) => s.keys).join()
    );

    // The one that earns the function: an unfiled field still shows up.
    const withStranger = sec.arrange([...allSectionKeys, "zzzNewField"]);
    check(
      "an unplaced field lands in More rather than disappearing",
      withStranger[withStranger.length - 1].id === sec.MORE_SECTION.id &&
        withStranger[withStranger.length - 1].keys.includes("zzzNewField")
    );
    check(
      "More is not offered when everything is filed",
      !arranged.some((s) => s.id === sec.MORE_SECTION.id)
    );

    // A player is handed fewer keys, and must not be shown the outline
    // of what was withheld.
    const dmSection = sec.NPC_SECTIONS.find((s) => s.id === "dm");
    const playerKeys = allSectionKeys.filter(
      (k) => !dmSection.keys.includes(k)
    );
    const forPlayer = sec.arrange(playerKeys);
    check(
      "a player gets no DM-only section at all",
      !forPlayer.some((s) => s.id === "dm")
    );
    check(
      "a player's DM-only fields are not smuggled into More",
      !forPlayer.flatMap((s) => s.keys).some((k) => dmSection.keys.includes(k))
    );
    check(
      "a player keeps everything else",
      forPlayer.flatMap((s) => s.keys).sort().join() ===
        playerKeys.slice().sort().join()
    );

    check("arrange on nothing is nothing", sec.arrange([]).length === 0);
    check(
      "arrange ignores a key it was not given",
      sec
        .arrange(["job"])
        .flatMap((s) => s.keys)
        .join() === "job"
    );

    // ---- Rules Lawyer: cutting a document into sections ------------
    // The chunker is plain ESM in scripts/, so it imports directly —
    // no compile step. It runs once per import, which is exactly why it
    // needs testing: a mistake here is baked into every row and only
    // shows up as a rule that reads oddly weeks later.
    const srd = await import(
      pathToFileURL(appPath("scripts", "srdChunks.mjs")).href
    );

    const DOC = [
      "Licensed under CC-BY-4.0.",
      "",
      "# System Reference Document",
      "",
      "## Rules Glossary",
      "",
      "Terms used throughout.",
      "",
      "### Grappled",
      "",
      "Your Speed is 0 and cannot increase.",
      "",
      "### Prone",
      "",
      "You can only crawl.",
      "",
      "## Combat",
      "",
      "### Making an Attack",
      "",
      "An attack has a simple structure.",
    ].join("\n");

    const cut = srd.chunkMarkdown(DOC, "SRD 5.2");
    const byTitle = (t) => cut.find((c) => c.title === t);

    // Five, not seven: "System Reference Document" and "Combat" are
    // headings with nothing directly under them, and a heading whose
    // content is all in its children is a table-of-contents entry.
    check("every section with text in it is found", cut.length === 5);
    check(
      "the breadcrumb is the trail ABOVE a section, not including it",
      byTitle("Grappled").breadcrumb ===
        "System Reference Document > Rules Glossary"
    );
    check(
      "a section is filed under the chapter it is actually in",
      byTitle("Making an Attack").breadcrumb === "System Reference Document > Combat"
    );

    // The one that goes wrong quietly. A heading stack that is never
    // truncated only shows it when a document skips a level — and real
    // documents skip levels. Here the glossary's "Grappled" is still
    // sitting at depth 3 when "Cover" asks for its trail, so a
    // condition turns up in the middle of the combat rules.
    const skipped = srd.chunkMarkdown(
      [
        "# SRD",
        "",
        "## Rules Glossary",
        "",
        "### Grappled",
        "",
        "Your Speed is 0.",
        "",
        "## Combat",
        "",
        "#### Cover",
        "",
        "A target can benefit from cover.",
      ].join("\n"),
      "T"
    );
    check(
      "a shallower heading truncates the trail",
      skipped.find((c) => c.title === "Cover").breadcrumb === "SRD > Combat"
    );
    check(
      "text before the first heading is kept, not discarded",
      cut[0].text.includes("CC-BY-4.0") && cut[0].title === "SRD 5.2"
    );
    check(
      "a heading with nothing under it is dropped",
      !cut.some((c) => c.text.trim() === "")
    );
    check(
      "order is contiguous after the empty ones go",
      cut.map((c) => c.order).join() ===
        cut.map((_, i) => i).join()
    );
    check(
      "the source is carried onto every section",
      cut.every((c) => c.source === "SRD 5.2")
    );
    check(
      "searchTextOf folds the heading and trail into the text",
      srd
        .searchTextOf(byTitle("Grappled"))
        .toLowerCase()
        .includes("rules glossary") &&
        srd.searchTextOf(byTitle("Grappled")).includes("Speed is 0")
    );

    // A long section splits at paragraph boundaries and loses nothing.
    const long =
      "# Long\n\n" +
      Array.from(
        { length: 200 },
        (_, i) => `Paragraph ${i} with enough words to take up room on the page.`
      ).join("\n\n");
    const parts = srd.chunkMarkdown(long, "T");
    check("a long section is split", parts.length > 1);
    check(
      "every part is under the cap",
      parts.every((p) => p.text.length <= srd.CHUNK_LIMITS.maxChars)
    );
    check(
      "no part begins mid-sentence",
      parts.every((p) => /^[A-Z#|*]/.test(p.text.trim()))
    );
    check(
      "splitting loses no paragraphs",
      parts.map((p) => p.text).join("\n\n").split("Paragraph ").length - 1 === 200
    );
    check(
      "every part keeps the section title",
      new Set(parts.map((p) => p.title)).size === 1
    );
    check(
      "no part before the last is a stub",
      parts.every(
        (p, i) =>
          i === parts.length - 1 ||
          p.text.length >= srd.CHUNK_LIMITS.minChars
      )
    );

    // Both fixtures below have to be long enough to actually split:
    // splitLong returns early on anything under the cap, so a short
    // document proves nothing about either rule. An earlier version of
    // these two tests used four-line documents and passed with the
    // behaviour removed.
    const FILLER =
      "Filler prose that exists only to push this section past the split cap.";
    const fillTo = (limit) => {
      let body = "";
      while (body.length + FILLER.length + 2 <= limit) {
        body += (body ? "\n\n" : "") + FILLER;
      }
      return body;
    };

    // A table separated from its introduction is a grid of numbers
    // with no column meanings. The filler puts the split boundary right
    // between the two, which is where it would come apart.
    const rows = Array.from(
      { length: 12 },
      (_, i) => `| Weapon ${i} | ${20 + i * 10} | ${80 + i * 40} |`
    );
    const tabled = srd.chunkMarkdown(
      `# Ranges\n\n${fillTo(3900)}\n\nThe ranges are:\n\n${[
        "| Weapon | Normal | Long |",
        "|---|---|---|",
        ...rows,
      ].join("\n")}`,
      "T"
    );
    const withTable = tabled.find((c) => c.text.includes("Weapon 11"));
    check("the table fixture actually splits", tabled.length > 1);
    check(
      "a table stays with the sentence that introduces it",
      Boolean(withTable && withTable.text.includes("The ranges are:"))
    );

    // A closing paragraph on its own is a chunk that says nothing: the
    // filler leaves exactly that orphan at the end.
    const TAIL =
      "A closing paragraph too short to stand on its own as a section of the rules.";
    const stubbed = srd.chunkMarkdown(`# Stub\n\n${fillTo(3990)}\n\n${TAIL}`, "T");
    check(
      "a short trailing stub is folded back rather than left alone",
      stubbed.every((c) => c.text.length >= srd.CHUNK_LIMITS.minChars) &&
        stubbed[stubbed.length - 1].text.endsWith(TAIL)
    );

    check("an empty document yields nothing", srd.chunkMarkdown("", "T").length === 0);
    check(
      "a document that is only headings yields nothing",
      srd.chunkMarkdown("# A\n\n## B\n\n### C", "T").length === 0
    );

    // ---- Rules Lawyer: showing a result ----------------------------
    const rsOut = compile("components/rulesSnippet.ts");
    const rs = await import(
      pathToFileURL(join(rsOut, "rulesSnippet.js")).href
    );

    check(
      "queryTerms lowercases and splits",
      rs.queryTerms("Grappled Condition").sort().join() === "condition,grappled"
    );
    check(
      "one-letter words are dropped — they would match everything",
      !rs.queryTerms("a grappled").includes("a")
    );
    check("queryTerms deduplicates", rs.queryTerms("attack attack").length === 1);
    check("an empty query has no terms", rs.queryTerms("").length === 0);

    // highlight returns SPANS, never markup: this is document text
    // going onto a page, and building HTML from it is how a file ends
    // up executing in a browser.
    const spans = rs.highlight("Your Speed is 0", ["speed"]);
    check(
      "highlight rejoins to exactly the original text",
      spans.map((s) => s.text).join("") === "Your Speed is 0"
    );
    check(
      "the matched run is marked and the rest is not",
      spans.filter((s) => s.hit).map((s) => s.text).join() === "Speed"
    );
    check(
      "matching is case-insensitive but preserves the original case",
      rs
        .highlight("SPEED speed", ["speed"])
        .filter((s) => s.hit)
        .map((s) => s.text)
        .join(",") === "SPEED,speed"
    );
    check(
      "overlapping terms do not produce duplicated text",
      rs.highlight("attacking", ["attack", "attacking"]).map((s) => s.text).join("") ===
        "attacking"
    );
    check(
      "no terms leaves the text whole and unmarked",
      (() => {
        const s = rs.highlight("plain text", []);
        return s.length === 1 && !s[0].hit && s[0].text === "plain text";
      })()
    );
    check(
      "highlight never emits markup of its own",
      !JSON.stringify(rs.highlight("<b>x</b>", ["x"])).includes("mark")
    );

    // The snippet opens where the matches are densest, not at the
    // first passing mention.
    const passage =
      "The word appears here once. " +
      "Filler sentence. ".repeat(30) +
      "Now the word is explained: the word means the word properly.";
    const snip = rs.snippet(passage, ["word"], 120);
    check("a snippet respects its length", snip.length <= 130);
    check(
      "a snippet opens on the densest run of matches",
      snip.includes("explained") || snip.includes("means")
    );
    // Both ends, checked separately. An "either end" assertion passes
    // when one of the two ellipses stops being written, which is the
    // half that matters: an extract that looks like a whole rule is
    // exactly the mistake this tool exists to prevent.
    const fromTop = rs.snippet(passage, ["appears"], 120);
    check("a cut at the front is marked", snip.startsWith("…"));
    check("a cut at the back is marked", fromTop.endsWith("…"));
    check("an end that was not cut gets no ellipsis", !fromTop.startsWith("…"));
    check(
      "a short section is returned whole, with no ellipsis",
      rs.snippet("Short rule.", ["rule"], 120) === "Short rule."
    );
    check(
      "a snippet with no match still shows the opening",
      rs.snippet(passage, ["absent"], 60).startsWith("The word appears")
    );
    check(
      "a snippet is a contiguous run of the real text",
      passage.replace(/\s+/g, " ").includes(snip.replace(/^…|…$/g, "").trim())
    );

    check(
      "trailOf reads as a path",
      rs.trailOf("Rules Glossary > Conditions", "Grappled") ===
        "Rules Glossary › Conditions › Grappled"
    );
    check(
      "a section with no trail is just its title",
      rs.trailOf("", "Combat") === "Combat"
    );

    // ---- edit mode: the registry, merged and exported --------------
    const uiOut = compile("components/uiRegistry.ts");
    const ui = await import(pathToFileURL(join(uiOut, "uiRegistry.js")).href);

    check(
      "with nothing saved you get the shipped wording",
      ui.textFor([]).get("record.info.title") === "NPC Info"
    );
    check(
      "a saved rename replaces it",
      ui.textFor([{ id: "record.info.title", value: "Who They Are" }]).get(
        "record.info.title"
      ) === "Who They Are"
    );
    // A rename of something that no longer exists is a rename of
    // nothing. Kept, it would appear in the export as a change to a
    // part of the app that is gone.
    check(
      "an id that is not in the registry is dropped",
      !ui.textFor([{ id: "gone.away", value: "x" }]).has("gone.away")
    );
    check(
      "an empty rename leaves the shipped wording alone",
      ui.textFor([{ id: "record.info.title", value: "   " }]).get(
        "record.info.title"
      ) === "NPC Info"
    );
    check(
      "a rename is trimmed",
      ui.cleanText("  Spaced  Out  ") === "Spaced Out"
    );
    check("a non-string is not a rename", ui.cleanText(42) === null);
    check(
      "a rename is capped",
      (ui.cleanText("x".repeat(9999)) ?? "").length ===
        ui.UI_LIMITS.textLength
    );

    // Labels are single-line by definition: one that breaks a line
    // rearranges the row it sits in.
    check(
      "a newline in a rename collapses to a space",
      ui.cleanText("Two\nLines") === "Two Lines"
    );
    // The one that the whitespace pass does NOT cover, and the reason
    // there are two passes. A NUL or a DEL is not whitespace, survives
    // /\s+/ untouched, and ends up in the file this rename is exported
    // into — where it makes the whole file binary to grep. A DEL got
    // into uiRegistry.ts exactly this way while it was being written.
    check(
      "a NUL in a rename is stripped, not passed through",
      ui.cleanText(`A${String.fromCharCode(0)}B`) === "A B"
    );
    check(
      "a DEL in a rename is stripped too",
      ui.cleanText(`A${String.fromCharCode(127)}B`) === "A B"
    );

    check(
      "a layout number outside its range is clamped, not refused",
      ui.clampLayout("record.split", 999) === 75 &&
        ui.clampLayout("record.split", -10) === 25
    );
    check(
      "a layout id that is not registered has no value",
      ui.clampLayout("nope", 50) === null
    );
    check(
      "a dragged fraction lands on a whole step",
      ui.clampLayout("record.split", 52.4) === 52
    );
    check(
      "text that is not a number leaves the shipped value",
      ui.layoutFor([{ id: "record.split", value: NaN }]).get("record.split") ===
        52
    );

    // Only differences are stored and only differences are exported —
    // a value that happens to equal the default is not a change.
    check(
      "a rename back to the shipped wording is not a change",
      ui.changedText(
        ui.textFor([{ id: "record.info.title", value: "NPC Info" }])
      ).length === 0
    );
    check(
      "a real rename is a change",
      ui.changedText(
        ui.textFor([{ id: "record.info.title", value: "Dossier" }])
      ).length === 1
    );

    const exported = ui.exportOverrides(
      ui.textFor([{ id: "record.info.title", value: "Dossier" }]),
      ui.layoutFor([{ id: "record.split", value: 60 }]),
      "2026-08-23"
    );
    check(
      "the export names the id, the new value and the old one",
      exported.includes("record.info.title") &&
        exported.includes('"Dossier"') &&
        exported.includes('"NPC Info"')
    );
    check(
      "the export carries the layout change too",
      exported.includes("record.split") &&
        exported.includes("60") &&
        exported.includes("was 52")
    );
    check(
      "an export with nothing changed says so instead of emitting a patch",
      ui.exportOverrides(ui.textFor([]), ui.layoutFor([]), "d").includes(
        "Nothing has been changed"
      )
    );
    // A heading containing a quote mark would close the string literal
    // early and paste as code that does not parse.
    check(
      "a quote mark in a rename is escaped in the export",
      ui
        .exportOverrides(
          ui.textFor([{ id: "record.info.title", value: 'The "Real" Story' }]),
          ui.layoutFor([]),
          "d"
        )
        .includes('\\"Real\\"')
    );

    check(
      "every registered id is unique",
      new Set([...ui.TEXT_PIECES, ...ui.LAYOUT_PIECES].map((p) => p.id)).size ===
        ui.TEXT_PIECES.length + ui.LAYOUT_PIECES.length
    );
    check(
      "every layout default sits inside its own range",
      ui.LAYOUT_PIECES.every((p) => p.value >= p.min && p.value <= p.max)
    );

    // ---- edit mode survives leaving the screen ---------------------
    // Every page renders its own AppShell, so navigating unmounts the
    // provider. React state does not cross that: edit mode switched
    // itself off exactly when you walked to the screen you wanted to
    // edit, which is how it shipped and how it was reported.
    const stashed = ui.encodeStash({
      editing: true,
      text: [{ id: "record.info.title", value: "Dossier" }],
      layout: [{ id: "record.split", value: 60 }],
    });
    const back = ui.decodeStash(stashed);
    check("the flag comes back", back.editing === true);
    check(
      "an unsaved rename comes back",
      back.text[0]?.id === "record.info.title" &&
        back.text[0]?.value === "Dossier"
    );
    check("an unsaved drag comes back", back.layout[0]?.value === 60);
    check(
      "the key is per campaign, so a draft cannot cross into another",
      ui.stashKey("aaa") !== ui.stashKey("bbb")
    );

    // Anything unreadable is the empty stash, never a thrown error. A
    // stale or hand-edited value in a browser store must not be able to
    // stop the app from rendering.
    check("nothing stored is nothing restored", !ui.decodeStash(null).editing);
    check("junk is not a stash", !ui.decodeStash("{{{").editing);
    check("a non-string is not a stash", !ui.decodeStash(42).editing);
    check(
      "an array where an object belongs is not a stash",
      ui.decodeStash("[1,2,3]").text.length === 0
    );
    check(
      "a stash of the wrong shape drops what it cannot read",
      ui.decodeStash('{"editing":"yes","text":[{"id":5}],"layout":null}')
        .text.length === 0
    );
    check(
      "a stashed id that is no longer registered is dropped",
      ui.decodeStash('{"text":[{"id":"gone","value":"x"}]}').text.length === 0
    );
    check(
      "a stashed number outside its range comes back clamped",
      ui.decodeStash('{"layout":[{"id":"record.split","value":999}]}')
        .layout[0]?.value === 75
    );

    // The settings tabs render their labels from a loop, so their ids
    // are built rather than written out — which is the one shape the
    // integrity guard cannot read. It checks the FAMILY is rendered;
    // this checks the family is exactly right, in both directions. A
    // tab added without a registry entry would show its own id as its
    // label; an entry left behind by a removed tab is a rename of
    // nothing.
    // `st` is the settingsTabs module, already compiled and imported
    // further up — compiling it twice would give two module instances
    // and quietly compare a thing against itself.
    const tabIds = st.SETTINGS_TABS.map((t) => `settings.tab.${t.id}`);
    const registeredTabIds = ui.TEXT_PIECES.map((p) => p.id).filter((id) =>
      id.startsWith("settings.tab.")
    );
    check(
      "every settings tab has a registry entry",
      tabIds.every((id) => ui.TEXT_BY_ID.has(id))
    );
    check(
      "no registry entry is left over from a removed tab",
      registeredTabIds.every((id) => tabIds.includes(id))
    );
    check(
      "each registered tab label matches the tab it names",
      st.SETTINGS_TABS.every(
        (t) => ui.TEXT_BY_ID.get(`settings.tab.${t.id}`)?.value === t.label
      )
    );

    // ---- carrying a list on when you press Enter -------------------
    const lcOut = compile("components/listContinue.ts");
    const lc = await import(
      pathToFileURL(join(lcOut, "listContinue.js")).href
    );

    check(
      "a numbered item gives the next number",
      lc.continueList("1. the toolbar is wrong")?.insert === "\n2. "
    );
    check(
      "it counts on from the number that is there, not from one",
      lc.continueList("6. and another thing")?.insert === "\n7. "
    );
    check(
      "a paren marker stays a paren marker",
      lc.continueList("3) like this")?.insert === "\n4) "
    );
    check(
      "a bullet stays a bullet",
      lc.continueList("- first")?.insert === "\n- " &&
        lc.continueList("* first")?.insert === "\n* "
    );
    check(
      "indentation carries, so a nested list stays nested",
      lc.continueList("   2. nested")?.insert === "\n   3. "
    );

    // Only the line the caret is ON. A list two paragraphs up is not
    // the thing Enter should continue.
    check(
      "a plain line is left alone",
      lc.continueList("just a sentence") === null
    );
    check(
      "an empty field is left alone",
      lc.continueList("") === null
    );
    check(
      "only the last line counts",
      lc.continueList("1. first\n\nplain prose now") === null
    );
    // The one that discriminates: reading the WHOLE field instead of
    // the caret's line matches nothing here and quietly stops
    // continuing lists that do not start at the top of the box.
    check(
      "a list that starts partway down still continues",
      lc.continueList("some intro\n2. second")?.insert === "\n3. "
    );
    check(
      "a number that is not a marker is left alone",
      lc.continueList("1985 was a good year") === null &&
        lc.continueList("3.5 inches") === null
    );

    // Enter on an EMPTY item ends the list. It is the only way out that
    // does not mean deleting the marker by hand.
    const ended = lc.continueList("2. ");
    check("an empty item ends the list", ended?.insert === "\n");
    check("and takes its marker with it", ended?.remove === 3);
    check(
      "an empty bullet ends the list too",
      lc.continueList("- ")?.remove === 2
    );

    check(
      "markerOf reads the parts it needs",
      lc.markerOf("  4. words").number === 4 &&
        lc.markerOf("  4. words").indent === "  " &&
        lc.markerOf("- words").number === null
    );

    // The whole edit, caret included: setting the text without moving
    // the caret puts it at the end of the field, which on a six-line
    // report is nowhere near where you were typing.
    const applied = lc.applyContinuation(
      "1. first",
      8,
      lc.continueList("1. first")
    );
    check(
      "applying inserts at the caret",
      applied.value === "1. first\n2. "
    );
    check("and the caret follows it", applied.caret === applied.value.length);

    const mid = lc.applyContinuation(
      "1. first\ntail",
      8,
      lc.continueList("1. first")
    );
    check(
      "text after the caret survives",
      mid.value === "1. first\n2. \ntail" && mid.caret === 12
    );

    const cleared = lc.applyContinuation("1. a\n2. ", 8, lc.continueList("2. "));
    check(
      "ending a list removes the empty marker",
      cleared.value === "1. a\n\n"
    );

    // ---- invite links: three independent ways to die ---------------
    // An invite is an UNAUTHENTICATED door into a campaign — anyone
    // holding the link is anyone at all until they sign in. So the
    // clock, the counter and the DM's Cancel are each checked on the
    // way in, and the reasons are ordered so the message names what
    // actually happened.
    const invOut = compile("components/inviteModel.ts");
    const inv = await import(pathToFileURL(join(invOut, "inviteModel.js")).href);

    const NOW = 1_700_000_000_000;
    const live = { expiresAt: NOW + 1000, usesLeft: 1 };

    check("a live invite has no problem", inv.inviteProblem(live, NOW) === null);
    check(
      "a token nobody issued is unknown",
      inv.inviteProblem(null, NOW) === "unknown"
    );
    check(
      "an expired invite is expired",
      inv.inviteProblem({ ...live, expiresAt: NOW - 1 }, NOW) === "expired"
    );
    check(
      "expiry is inclusive — the instant it lands, it is dead",
      inv.inviteProblem({ ...live, expiresAt: NOW }, NOW) === "expired"
    );
    check(
      "a spent invite is spent",
      inv.inviteProblem({ ...live, usesLeft: 0 }, NOW) === "spent"
    );
    check(
      "a negative counter is spent, not live",
      inv.inviteProblem({ ...live, usesLeft: -3 }, NOW) === "spent"
    );

    // Revoked beats expired beats spent: a link the DM killed on Monday
    // should not report itself as having expired on Friday.
    check(
      "revoking wins over expiry",
      inv.inviteProblem(
        { expiresAt: NOW - 1, usesLeft: 0, revokedAt: NOW - 2 },
        NOW
      ) === "revoked"
    );
    check(
      "expiry wins over the counter",
      inv.inviteProblem({ expiresAt: NOW - 1, usesLeft: 0 }, NOW) === "expired"
    );

    // A token that never existed and one that died must read the same
    // to a stranger: telling somebody which of their guesses was a real
    // campaign is telling them something.
    check(
      "an unknown token does not admit it is unknown",
      !inv.inviteMessage("unknown").toLowerCase().includes("exist") &&
        !inv.inviteMessage("unknown").toLowerCase().includes("wrong")
    );
    check(
      "every reason gets words of its own",
      new Set(
        ["unknown", "revoked", "expired", "spent"].map((p) =>
          inv.inviteMessage(p)
        )
      ).size === 4
    );

    check(
      "days are clamped to what the app will issue",
      inv.clampDays(99999) === inv.INVITE_LIMITS.maxDays &&
        inv.clampDays(0) === inv.INVITE_LIMITS.defaultDays &&
        inv.clampDays(-5) === inv.INVITE_LIMITS.defaultDays &&
        inv.clampDays("nonsense") === inv.INVITE_LIMITS.defaultDays
    );
    check(
      "uses are clamped the same way",
      inv.clampUses(99999) === inv.INVITE_LIMITS.maxUses &&
        inv.clampUses(0) === inv.INVITE_LIMITS.defaultUses &&
        inv.clampUses(2) === 2
    );
    check(
      "an expiry is in the future and inside the cap",
      inv.expiryFrom(NOW, 7) === NOW + 7 * 86400000 &&
        inv.expiryFrom(NOW, 99999) ===
          NOW + inv.INVITE_LIMITS.maxDays * 86400000
    );

    // The token is the whole credential.
    const token = inv.tokenFrom(
      Uint8Array.from({ length: 16 }, (_, i) => i * 7)
    );
    check(
      "a token is hex of the full length",
      token.length === inv.INVITE_LIMITS.tokenLength && /^[0-9a-f]+$/.test(token)
    );
    check(
      "different bytes make different tokens",
      inv.tokenFrom(Uint8Array.from({ length: 16 }, () => 1)) !==
        inv.tokenFrom(Uint8Array.from({ length: 16 }, () => 2))
    );
    check(
      "a byte under 16 is padded, not shortened",
      inv.tokenFrom(Uint8Array.from([1, 255])).startsWith("01ff")
    );

    check(
      "the link is built from the origin it is shown on",
      inv.inviteUrl("https://x.test", "abc") === "https://x.test/join/abc"
    );
    check(
      "a trailing slash does not double up",
      inv.inviteUrl("https://x.test/", "abc") === "https://x.test/join/abc"
    );

    check(
      "expiry reads as a sentence",
      inv.expiryText(NOW + 13 * 86400000, NOW) === "expires in 13 days" &&
        inv.expiryText(NOW + 86400000, NOW) === "expires tomorrow" &&
        inv.expiryText(NOW - 1, NOW) === "expired"
    );

    // ---- what a note is allowed to contain -------------------------
    // A player writing a note is handing markup to the DM's browser.
    // Every case below is something that renders as a script, a
    // request, or a hijacked page if it survives — so this is the one
    // module where a passing test is the actual security property and
    // not a proxy for it.
    const nfOut = compile("components/noteFormat.ts");
    const nf = await import(pathToFileURL(join(nfOut, "noteFormat.js")).href);

    const clean = (s) => nf.sanitizeNoteHtml(s);
    const has = (s, needle) => clean(s).toLowerCase().includes(needle);

    check(
      "ordinary formatting survives",
      clean("<p>Hello <b>there</b> and <em>hi</em></p>") ===
        "<p>Hello <b>there</b> and <em>hi</em></p>"
    );
    check(
      "lists survive, which is half the point of rich notes",
      clean("<ul><li>one</li><li>two</li></ul>") ===
        "<ul><li>one</li><li>two</li></ul>"
    );

    // ---- scripts ----
    check("a script tag is gone", !has("<script>alert(1)</script>", "script"));
    check(
      "and its CONTENTS go with it",
      !clean("<script>alert(1)</script>").includes("alert")
    );
    check(
      "an unclosed script does not leak its body",
      !clean("<script>alert(1)").includes("alert")
    );
    check(
      "a script hidden in mixed case is still a script",
      !has("<ScRiPt>alert(1)</ScRiPt>", "alert")
    );
    check("style blocks go too", !has("<style>body{x:1}</style>", "style"));
    check("iframes go", !has('<iframe src="x"></iframe>', "iframe"));
    check("svg goes, because it can carry script", !has("<svg><g/></svg>", "svg"));

    // ---- event handlers ----
    // The classic: a tag that IS allowed, carrying an attribute that is
    // not. The attribute has to go without taking the tag with it.
    check(
      "onerror is dropped from an allowed tag",
      !has('<b onerror="alert(1)">x</b>', "onerror")
    );
    check(
      "onclick is dropped and the text kept",
      clean('<p onclick="alert(1)">hello</p>') === "<p>hello</p>"
    );
    check(
      "an unquoted handler is dropped too",
      !has("<p onclick=alert(1)>x</p>", "onclick")
    );
    check(
      "style attributes are dropped",
      !has('<p style="position:fixed;inset:0">x</p>', "style=")
    );

    // ---- links ----
    check(
      "an http link survives",
      has('<a href="https://example.com">x</a>', 'href="https://example.com"')
    );
    check(
      "and opens elsewhere, without handing over the opener",
      has('<a href="https://example.com">x</a>', 'rel="noopener noreferrer"')
    );
    check(
      "a javascript: link loses its href",
      !has('<a href="javascript:alert(1)">x</a>', "javascript")
    );
    // The one a naive check misses: browsers strip control characters
    // before resolving a scheme, so "java\tscript:" runs.
    check(
      "a javascript: link with a tab in the scheme still loses it",
      !has('<a href="java\tscript:alert(1)">x</a>', "javascript") &&
        !has('<a href="java\nscript:alert(1)">x</a>', "javascript")
    );
    check(
      "leading spaces do not smuggle a scheme past",
      !has('<a href="  javascript:alert(1)">x</a>', "javascript")
    );
    check(
      "a data: link is refused",
      !has('<a href="data:text/html,<script>1</script>">x</a>', "data:")
    );
    check(
      "a relative link is fine",
      has('<a href="/campaign/x">y</a>', 'href="/campaign/x"')
    );

    // ---- images are not markup ----
    check(
      "an img is unwrapped, so a note body never fetches anything",
      !has('<img src="https://tracker.example/pixel.gif">', "img")
    );

    // ---- structure ----
    check(
      "an unknown tag is unwrapped, keeping its words",
      clean("<marquee>hello</marquee>") === "hello"
    );
    check(
      "a stray closing tag cannot close something it did not open",
      clean("</b>plain") === "plain"
    );
    check(
      "an unclosed tag is closed rather than left hanging",
      clean("<b>bold") === "<b>bold</b>"
    );
    check(
      "tags are closed in the right order",
      clean("<p><b>x") === "<p><b>x</b></p>"
    );
    check(
      "text with a bare < is escaped, not read as a tag",
      clean("5 < 6 and 7 > 2").includes("&lt;")
    );
    check(
      "an ampersand is escaped once, not twice",
      clean("Tom & Jerry") === "Tom &amp; Jerry"
    );
    check("comments are dropped", clean("<!-- hi -->x") === "x");
    check(
      "sanitising is idempotent",
      clean(clean('<p onclick="x">a<script>b</script></p>')) ===
        clean('<p onclick="x">a<script>b</script></p>')
    );
    check(
      "a body longer than the limit is cut, not refused",
      clean("<p>" + "a".repeat(nf.NOTE_LIMITS.body * 2) + "</p>").length <=
        nf.NOTE_LIMITS.body + 64
    );
    check("empty in, empty out", clean("") === "" && clean(null) === "");

    // ---- is there anything in it ----
    check(
      "an untouched editor counts as empty",
      nf.isEmptyNote("<p><br></p>") && nf.isEmptyNote("<div><br></div>")
    );
    check(
      "whitespace and entities count as empty",
      nf.isEmptyNote("   ") && nf.isEmptyNote("<p>&nbsp;</p>")
    );
    check("real words do not", !nf.isEmptyNote("<p>hello</p>"));
    check(
      "noteText puts a space where a block ended",
      nf.noteText("<p>one</p><p>two</p>") === "one two"
    );

    // ---- when ----
    const t0 = 1_700_000_000_000;
    check("seconds read as just now", nf.whenText(t0, t0 + 5_000) === "just now");
    check(
      "minutes and hours are counted",
      nf.whenText(t0, t0 + 5 * 60_000) === "5 minutes ago" &&
        nf.whenText(t0, t0 + 3 * 3_600_000) === "3 hours ago"
    );
    check(
      "one of something is singular",
      nf.whenText(t0, t0 + 60_000) === "1 minute ago" &&
        nf.whenText(t0, t0 + 24 * 3_600_000) === "1 day ago"
    );
    check(
      "past a fortnight it gives a date instead of a count",
      /\d{4}$/.test(nf.whenText(t0, t0 + 400 * 24 * 3_600_000))
    );
    check(
      "a clock skewed into the future does not read as negative",
      nf.whenText(t0, t0 - 60_000) === "just now"
    );

    // ---- the sidebar, as its owner arranged it ---------------------
    // Two ways this loses a screen, and both are silent. An item the
    // layout does not mention is not hidden but ABSENT — no entry, and
    // no hint that there is one to un-hide. And hiding Settings would
    // remove the only way back to the page that un-hides things.
    const sbOut = compile("components/sidebarLayout.ts");
    const sb = await import(
      pathToFileURL(join(sbOut, "sidebarLayout.js")).href
    );

    const GROUPS = [
      { id: "campaign", title: "Campaign", itemIds: ["table", "npcs"] },
      { id: "tools", title: "Tools", itemIds: ["chat", "dice"] },
      { id: "settings", title: "", itemIds: ["settings"] },
    ];
    const IDS = ["table", "npcs", "chat", "dice", "settings"];
    const sbBase = sb.defaultSidebar(GROUPS);

    check(
      "defaultSidebar places every item, visible",
      sb.sidebarIds(sbBase).join() === IDS.join() &&
        sbBase.sections.every((s) => s.items.every((i) => !i.hidden))
    );
    check(
      "reconcile is idempotent",
      eq(
        sb.reconcileSidebar(sb.reconcileSidebar(sbBase, IDS), IDS),
        sb.reconcileSidebar(sbBase, IDS)
      )
    );
    // Idempotence alone does not say this. Writing `dmOnly: false` onto
    // every section on every pass is perfectly idempotent, and stamps a
    // key nobody set into the layout of everyone who has never used the
    // feature — which is then what gets saved.
    check(
      "and a layout that uses neither flag comes back exactly as it went in",
      eq(sb.reconcileSidebar(sbBase, IDS), sbBase)
    );
    check(
      "a screen the layout never heard of is added, not lost",
      sb
        .sidebarIds(sb.reconcileSidebar(sbBase, [...IDS, "scheduler"]))
        .includes("scheduler")
    );
    check(
      "and it arrives visible",
      sb
        .reconcileSidebar(sbBase, [...IDS, "scheduler"])
        .sections.flatMap((s) => s.items)
        .find((i) => i.id === "scheduler").hidden === false
    );
    check(
      "an item that is no longer a screen is dropped",
      !sb.sidebarIds(sb.reconcileSidebar(sbBase, ["table", "settings"]))
        .includes("npcs")
    );
    check(
      "an item cannot be in two sections",
      sb
        .sidebarIds(
          sb.reconcileSidebar(
            {
              sections: [
                { id: "a", title: "A", items: [{ id: "npcs", hidden: false }] },
                { id: "b", title: "B", items: [{ id: "npcs", hidden: true }] },
              ],
            },
            ["npcs"]
          )
        )
        .join() === "npcs"
    );
    check(
      "an empty layout still places everything",
      sb.sidebarIds(sb.reconcileSidebar({ sections: [] }, IDS)).sort().join() ===
        IDS.slice().sort().join()
    );
    check(
      "sections cannot share an id",
      (() => {
        const r = sb.reconcileSidebar(
          {
            sections: [
              { id: "same", title: "A", items: [] },
              { id: "same", title: "B", items: [{ id: "npcs", hidden: false }] },
            ],
          },
          ["npcs"]
        );
        return new Set(r.sections.map((s) => s.id)).size === r.sections.length;
      })()
    );

    // The pin mechanism. Nothing uses it now — Settings was its only
    // member and has left the designer entirely — so it is checked
    // against a made-up entry, which is what keeps it honest for
    // whatever needs it next.
    check(
      "a pinned item cannot be hidden by toggling it",
      (() => {
        const pinned = sb.ALWAYS_VISIBLE;
        if (pinned.length === 0) return true; // nothing to pin today
        const id = pinned[0];
        return (
          sb
            .toggleHidden(sbBase, id)
            .sections.flatMap((s) => s.items)
            .find((i) => i.id === id)?.hidden !== true
        );
      })()
    );
    check(
      "an ordinary item still hides",
      sb
        .toggleHidden(sbBase, "npcs")
        .sections.flatMap((s) => s.items)
        .find((i) => i.id === "npcs").hidden === true
    );

    // ---- what the sidebar actually renders -------------------------
    check(
      "visibleSidebar drops what was hidden",
      !sb
        .visibleSidebar(sb.toggleHidden(sbBase, "npcs"), IDS, true)
        .flatMap((s) => s.items)
        .some((i) => i.id === "npcs")
    );
    check(
      "and drops a section left with nothing",
      sb.visibleSidebar(
        sb.toggleHidden(sbBase, "settings"),
        ["table", "npcs"],
        true
      ).length === 1
    );
    check(
      "a screen this person may not see is not rendered either",
      !sb
        .visibleSidebar(sbBase, ["table", "npcs", "settings"], true)
        .flatMap((s) => s.items)
        .some((i) => i.id === "dice")
    );
    check(
      "visibleSidebar does not mutate the layout",
      sb.sidebarIds(sbBase).join() === IDS.join()
    );

    // ---- a section that is only yours while you run the game -------
    // The DM's own preference, and the reason it exists is the preview:
    // View as Player is meant to show what the table sees, so a prep
    // section still standing in it would make the preview a lie about
    // the only screen it is checked on.
    const sbDm = sb.setSectionDmOnly(sbBase, "tools", true);
    check(
      "a DM-only section renders for the DM",
      sb.visibleSidebar(sbDm, IDS, true).some((s) => s.id === "tools")
    );
    check(
      "and is gone when you are not the DM here",
      !sb.visibleSidebar(sbDm, IDS, false).some((s) => s.id === "tools")
    );
    check(
      "its items go with it rather than surfacing elsewhere",
      !sb
        .visibleSidebar(sbDm, IDS, false)
        .flatMap((s) => s.items)
        .some((i) => i.id === "chat")
    );
    check(
      "the flag survives a round trip through reconcile",
      sb
        .reconcileSidebar(sbDm, IDS)
        .sections.find((s) => s.id === "tools")?.dmOnly === true
    );
    check(
      "unticking it takes the key back out rather than writing false",
      !("dmOnly" in
        sb
          .setSectionDmOnly(sbDm, "tools", false)
          .sections.find((s) => s.id === "tools"))
    );
    check(
      "marking a section DM-only does not hide its items for the DM",
      sb.sidebarIds(sbDm).join() === IDS.join()
    );

    // ---- folding a section up --------------------------------------
    // The heading is the whole of a folded section. Fold one that has
    // no heading and there is nothing left on screen to click, and the
    // items inside are gone with no hint that they exist.
    check(
      "a titled section folds",
      sb
        .setSectionCollapsed(sbBase, "tools", true)
        .sections.find((s) => s.id === "tools")?.collapsed === true
    );
    check(
      "an untitled one refuses to",
      sb
        .setSectionCollapsed(sbBase, "settings", true)
        .sections.find((s) => s.id === "settings")?.collapsed !== true
    );
    check(
      "toggling folds and unfolds",
      (() => {
        const one = sb.toggleSectionCollapsed(sbBase, "tools");
        const two = sb.toggleSectionCollapsed(one, "tools");
        return (
          one.sections.find((s) => s.id === "tools").collapsed === true &&
          two.sections.find((s) => s.id === "tools").collapsed !== true
        );
      })()
    );
    check(
      "clearing the heading of a folded section unfolds it",
      sb
        .renameSection(
          sb.setSectionCollapsed(sbBase, "tools", true),
          "tools",
          ""
        )
        .sections.find((s) => s.id === "tools")?.collapsed !== true
    );
    check(
      "and reconcile catches one that was folded and lost its heading",
      sb
        .reconcileSidebar(
          {
            sections: [
              {
                id: "tools",
                title: "",
                collapsed: true,
                items: [{ id: "chat", hidden: false }],
              },
            ],
          },
          ["chat"]
        )
        .sections.find((s) => s.id === "tools")?.collapsed !== true
    );
    check(
      "folding is not hiding — the items are still in the layout",
      sb.sidebarIds(sb.setSectionCollapsed(sbBase, "tools", true)).join() ===
        IDS.join()
    );
    check(
      "and a folded section still renders, so its heading is there to click",
      sb
        .visibleSidebar(sb.setSectionCollapsed(sbBase, "tools", true), IDS, true)
        .some((s) => s.id === "tools")
    );
    check(
      "reconcile stays idempotent with both flags set",
      (() => {
        const flagged = sb.setSectionCollapsed(
          sb.setSectionDmOnly(sbBase, "tools", true),
          "tools",
          true
        );
        return eq(
          sb.reconcileSidebar(sb.reconcileSidebar(flagged, IDS), IDS),
          sb.reconcileSidebar(flagged, IDS)
        );
      })()
    );

    // ---- moving things ---------------------------------------------
    check(
      "moveItem takes it out of the section it was in",
      !sb
        .moveItem(sbBase, "npcs", "tools", 0)
        .sections[0].items.some((i) => i.id === "npcs")
    );
    check(
      "moveItem keeps every item",
      sb.sidebarIds(sb.moveItem(sbBase, "npcs", "tools", 0)).sort().join() ===
        IDS.slice().sort().join()
    );
    check(
      "moveItem carries the hidden flag with it",
      sb
        .moveItem(sb.toggleHidden(sbBase, "npcs"), "npcs", "tools", 0)
        .sections.flatMap((s) => s.items)
        .find((i) => i.id === "npcs").hidden === true
    );
    check(
      "shiftItem reorders within a section",
      sb
        .shiftItem(sbBase, "npcs", -1)
        .sections[0].items.map((i) => i.id)
        .join() === "npcs,table"
    );
    check(
      "shiftItem at the edge does nothing rather than wrapping",
      eq(sb.shiftItem(sbBase, "table", -1), sbBase)
    );

    // ---- Shown and Hidden as two columns ---------------------------
    // Hidden items keep their place in the section so that showing one
    // puts it back where it was. But they are off screen, so stepping
    // over one would look like the arrow did nothing.
    const withHidden = {
      sections: [
        {
          id: "tools",
          title: "Tools",
          items: [
            { id: "chat", hidden: false },
            { id: "dice", hidden: true },
            { id: "npcs", hidden: false },
          ],
        },
      ],
    };
    check(
      "shownItems skips what is hidden",
      sb.shownItems(withHidden.sections[0]).map((i) => i.id).join() ===
        "chat,npcs"
    );
    check(
      "shiftItem hops over a hidden neighbour in one press",
      sb
        .shiftItem(withHidden, "chat", 1)
        .sections[0].items.map((i) => i.id)
        .join() === "dice,npcs,chat"
    );
    check(
      "and the item it swapped with really moved",
      sb
        .shiftItem(withHidden, "npcs", -1)
        .sections[0].items.map((i) => i.id)
        .join() === "npcs,chat,dice"
    );
    check(
      "shiftItem at the last VISIBLE position does nothing",
      eq(sb.shiftItem(withHidden, "npcs", 1), withHidden)
    );
    check(
      "a hidden item is not shifted at all",
      eq(sb.shiftItem(withHidden, "dice", 1), withHidden)
    );

    check(
      "hiddenItems collects across every section, flat",
      sb.hiddenItems(withHidden).map((i) => i.id).join() === "dice"
    );
    check(
      "hiddenItems is empty when nothing is hidden",
      sb.hiddenItems(sbBase).length === 0
    );

    check(
      "hideAll hides everything it may",
      sb
        .hiddenItems(sb.hideAll(sbBase))
        .map((i) => i.id)
        .sort()
        .join() ===
        IDS.filter((id) => !sb.ALWAYS_VISIBLE.includes(id)).slice().sort().join()
    );
    check(
      "hideAll leaves anything pinned alone",
      !sb
        .hiddenItems(sb.hideAll(sbBase))
        .some((i) => sb.ALWAYS_VISIBLE.includes(i.id))
    );

    // ---- setHidden, which is what a drag needs ---------------------
    // A drop into Hidden means hidden, whatever it was. A toggle would
    // make dragging an already-hidden item into Hidden un-hide it,
    // which is the opposite of what the gesture said.
    check(
      "setHidden(true) on something already hidden leaves it hidden",
      sb
        .setHidden(sb.setHidden(sbBase, "npcs", true), "npcs", true)
        .sections.flatMap((s) => s.items)
        .find((i) => i.id === "npcs").hidden === true
    );
    check(
      "setHidden(false) on something already shown leaves it shown",
      sb
        .setHidden(sbBase, "npcs", false)
        .sections.flatMap((s) => s.items)
        .find((i) => i.id === "npcs").hidden === false
    );
    check(
      "setHidden does not move the item out of its section",
      sb.sidebarIds(sb.setHidden(sbBase, "npcs", true)).join() === IDS.join()
    );
    check(
      "an unknown id changes nothing",
      eq(sb.setHidden(sbBase, "nope", true), sbBase)
    );
    check(
      "showAll brings everything back",
      sb.hiddenItems(sb.showAll(sb.hideAll(sbBase))).length === 0
    );
    check(
      "hideAll keeps every item, just switched off",
      sb.sidebarIds(sb.hideAll(sbBase)).join() === IDS.join()
    );

    check(
      "removeSection keeps its items",
      sb.sidebarIds(sb.removeSection(sbBase, "tools")).sort().join() ===
        IDS.slice().sort().join()
    );
    check(
      "the last section cannot be removed",
      sb.removeSection({ sections: [sbBase.sections[0]] }, "campaign")
        .sections.length === 1
    );
    check(
      "addSection appends an empty one",
      sb.addSection(sbBase, "Mine").sections.at(-1).items.length === 0
    );
    check(
      "addSection stops at the limit",
      (() => {
        let l = sbBase;
        for (let i = 0; i < 50; i++) l = sb.addSection(l, `S${i}`);
        return l.sections.length === sb.SIDEBAR_LIMITS.sections;
      })()
    );
    check(
      "renameSection allows an empty heading",
      sb.renameSection(sbBase, "tools", "").sections[1].title === ""
    );
    check(
      "shiftSection reorders the sidebar",
      sb
        .shiftSection(sbBase, "tools", -1)
        .sections.map((s) => s.id)
        .join() === "tools,campaign,settings"
    );

    // ---- the Scheduler ---------------------------------------------
    // Real dates and clock times, which is a different set of traps
    // from the campaign calendar: noon and midnight are both "12", and
    // an ISO date read through the local Date constructor is the day
    // before in every timezone west of Greenwich.
    const schOut = compile("components/scheduleModel.ts");
    const sch = await import(
      pathToFileURL(join(schOut, "scheduleModel.js")).href
    );

    check(
      "formatTime: morning and afternoon",
      [540, 570, 660].map(sch.formatTime).join() === "9:00 AM,9:30 AM,11:00 AM"
    );
    // The two the 12-hour clock gets wrong if you just take h % 12.
    check("formatTime: noon is 12 PM, not 0 PM", sch.formatTime(720) === "12:00 PM");
    check("formatTime: midnight is 12 AM, not 0 AM", sch.formatTime(0) === "12:00 AM");
    check("formatTime: half past noon", sch.formatTime(750) === "12:30 PM");
    check("formatTime: 11:59 PM stays PM", sch.formatTime(1439) === "11:59 PM");
    check(
      "formatTime pads the minutes",
      sch.formatTime(545) === "9:05 AM"
    );

    // A date is three numbers, never a local Date. `new Date("2026-08-25")`
    // is UTC midnight — the 24th in every US timezone — and a scheduler
    // that names the wrong weekday is worse than none.
    check(
      "dayLabel reads the date it was given",
      eq(sch.dayLabel("2026-08-25"), { date: "Aug 25", weekday: "Tue" })
    );
    check(
      "dayLabel: the first of a month",
      eq(sch.dayLabel("2026-01-01"), { date: "Jan 1", weekday: "Thu" })
    );
    check(
      "dayLabel: a leap day is a real day",
      eq(sch.dayLabel("2028-02-29"), { date: "Feb 29", weekday: "Tue" })
    );
    check(
      "isIsoDate rejects a day that does not exist",
      !sch.isIsoDate("2026-02-30") &&
        !sch.isIsoDate("2026-13-01") &&
        !sch.isIsoDate("2026-8-5") &&
        !sch.isIsoDate("not a date") &&
        sch.isIsoDate("2026-08-25")
    );
    check(
      "addIsoDays crosses a month, a year, and a leap day",
      sch.addIsoDays("2026-08-31", 1) === "2026-09-01" &&
        sch.addIsoDays("2026-12-31", 1) === "2027-01-01" &&
        sch.addIsoDays("2028-02-28", 1) === "2028-02-29" &&
        sch.addIsoDays("2026-01-01", -1) === "2025-12-31"
    );

    // ---- the day picker's real month -------------------------------
    // A real calendar, unlike the campaign's, has to know that
    // February is short and that some years it is not.
    check(
      "a 30-day month has 30 days",
      sch.realMonthGrid(2026, 8).flat().filter(Boolean).length === 30
    );
    check(
      "February is 28 in a common year and 29 in a leap year",
      sch.realMonthGrid(2026, 1).flat().filter(Boolean).length === 28 &&
        sch.realMonthGrid(2028, 1).flat().filter(Boolean).length === 29
    );
    check(
      "every row is a full week",
      sch.realMonthGrid(2026, 8).every((w) => w.length === 7)
    );
    check(
      "the 1st sits under its own weekday",
      sch.realMonthGrid(2026, 8).flat().indexOf("2026-09-01") === 2
    );
    check(
      "the days are in order with no gaps",
      (() => {
        const days = sch.realMonthGrid(2026, 8).flat().filter(Boolean);
        return days.every(
          (d, i) => i === 0 || d === sch.addIsoDays(days[i - 1], 1)
        );
      })()
    );

    // Anchored on the 1st, so stepping from the 31st cannot skip a
    // month whenever the next one is shorter.
    check(
      "addIsoMonths does not skip a short month",
      sch.addIsoMonths("2026-01-31", 1) === "2026-02-01" &&
        sch.addIsoMonths("2026-03-31", -1) === "2026-02-01"
    );
    check(
      "addIsoMonths rolls the year",
      sch.addIsoMonths("2026-12-05", 1) === "2027-01-01" &&
        sch.addIsoMonths("2026-01-05", -1) === "2025-12-01"
    );
    check(
      "monthTitle names the month and year",
      sch.monthTitle("2026-09-05") === "September 2026"
    );

    check(
      "toggleDay adds, removes, and keeps the list sorted",
      sch.toggleDay(["2026-09-05"], "2026-09-01").join() ===
        "2026-09-01,2026-09-05" &&
        sch.toggleDay(["2026-09-01", "2026-09-05"], "2026-09-01").join() ===
          "2026-09-05"
    );
    check(
      "toggleDay refuses a day that is not a date",
      sch.toggleDay(["2026-09-05"], "someday").join() === "2026-09-05"
    );
    check(
      "toggleDay stops at the limit rather than growing forever",
      (() => {
        let days = [];
        for (let i = 0; i < 60; i++) {
          days = sch.toggleDay(days, sch.addIsoDays("2026-01-01", i));
        }
        return days.length === sch.SCHEDULE_LIMITS.days;
      })()
    );
    check(
      "but a day already chosen can still be removed at the limit",
      (() => {
        let days = [];
        for (let i = 0; i < 60; i++) {
          days = sch.toggleDay(days, sch.addIsoDays("2026-01-01", i));
        }
        return sch.toggleDay(days, days[0]).length === days.length - 1;
      })()
    );

    // ---- the window -------------------------------------------------
    const W = sch.reconcileWindow({
      days: ["2026-08-25", "2026-08-26"],
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      slotMinutes: 30,
    });
    check("slotsOf spans the window", sch.slotsOf(W).length === 16);
    check("slotsOf starts at the start", sch.slotsOf(W)[0] === 540);
    check(
      "slotsOf stops before the end rather than past it",
      sch.slotsOf(W).at(-1) === 990
    );
    check(
      "a slot that would overrun the end is not offered",
      sch.slotsOf(
        sch.reconcileWindow({ ...W, endMinute: 9 * 60 + 45, slotMinutes: 30 })
      ).length === 1
    );
    check(
      "reconcileWindow is idempotent",
      eq(sch.reconcileWindow(sch.reconcileWindow(W)), sch.reconcileWindow(W))
    );
    check(
      "an end before the start still leaves one row to render",
      sch.slotsOf(
        sch.reconcileWindow({ ...W, startMinute: 600, endMinute: 60 })
      ).length === 1
    );
    check(
      "days are sorted and deduplicated",
      sch
        .reconcileWindow({
          ...W,
          days: ["2026-08-26", "2026-08-25", "2026-08-26"],
        })
        .days.join() === "2026-08-25,2026-08-26"
    );
    check(
      "a day that is not a date is dropped, not rendered",
      sch.reconcileWindow({ ...W, days: ["yesterday", "2026-08-25"] }).days
        .join() === "2026-08-25"
    );
    check(
      "isHourStart reads the clock, not the row",
      sch.isHourStart(540) && !sch.isHourStart(570) && sch.isHourStart(600)
    );
    // A 20-minute grid must still put its solid lines on the hours.
    check(
      "and does so at any cell size",
      sch
        .slotsOf(sch.reconcileWindow({ ...W, slotMinutes: 20 }))
        .filter(sch.isHourStart).length === 8
    );

    // ---- slot keys --------------------------------------------------
    check(
      "a slot key round-trips",
      eq(sch.parseSlotKey(sch.slotKey("2026-08-25", 540)), {
        day: "2026-08-25",
        minute: 540,
      })
    );
    check(
      "a malformed key is null rather than a wrong date",
      sch.parseSlotKey("nonsense") === null &&
        sch.parseSlotKey("2026-08-25Tlate") === null
    );

    // ---- who is free ------------------------------------------------
    const k = (d, m) => sch.slotKey(d, m);
    const people = [
      { userId: "u1", name: "Derek", slots: [k("2026-08-25", 540), k("2026-08-25", 570)] },
      { userId: "u2", name: "Ana", slots: [k("2026-08-25", 570), k("2026-08-25", 600)] },
      { userId: "u3", name: "Bo", slots: [] },
    ];
    const freeAt = sch.tally(people);
    check(
      "tally counts one person once",
      freeAt.get(k("2026-08-25", 540)).count === 1
    );
    check(
      "tally counts an overlap",
      freeAt.get(k("2026-08-25", 570)).count === 2
    );
    check(
      "tally names who is free",
      freeAt.get(k("2026-08-25", 570)).free.slice().sort().join() === "Ana,Derek"
    );
    // One person listing a slot twice must not read as two people.
    check(
      "a duplicated slot does not count twice",
      sch
        .tally([{ userId: "u", name: "Derek", slots: [k("2026-08-25", 540), k("2026-08-25", 540)] }])
        .get(k("2026-08-25", 540)).count === 1
    );
    check(
      "missing names the people who marked nothing",
      sch.missing(people).join() === "Bo"
    );

    check(
      "consensus finds the overlap first",
      sch.consensus(W, people, 1)[0].minute === 570
    );
    check(
      "a minimum nobody meets returns nothing rather than a best guess",
      sch.consensus(W, people, 3).length === 0
    );

    // ---- blocks -----------------------------------------------------
    // Consecutive slots with the SAME people merge; a run where the
    // group changes must not, or the summary claims a three-hour
    // window that nobody actually shares.
    const solid = [
      {
        userId: "u1",
        name: "Derek",
        slots: [540, 570, 600].map((m) => k("2026-08-25", m)),
      },
      {
        userId: "u2",
        name: "Ana",
        slots: [540, 570, 600].map((m) => k("2026-08-25", m)),
      },
    ];
    const merged = sch.blocks(W, solid, 2);
    check("blocks merges a run into one", merged.length === 1);
    check(
      "blocks spans the whole run",
      merged[0].startMinute === 540 && merged[0].endMinute === 630
    );
    const shifting = [
      { userId: "u1", name: "Derek", slots: [540, 570].map((m) => k("2026-08-25", m)) },
      { userId: "u2", name: "Ana", slots: [570, 600].map((m) => k("2026-08-25", m)) },
    ];
    check(
      "blocks does not merge across a change of who is free",
      sch.blocks(W, shifting, 1).length === 3
    );
    check(
      "a gap breaks a block",
      sch.blocks(
        W,
        [{ userId: "u", name: "D", slots: [k("2026-08-25", 540), k("2026-08-25", 660)] }],
        1
      ).length === 2
    );
    check(
      "blocks does not run across midnight into the next day",
      sch
        .blocks(
          W,
          [
            {
              userId: "u",
              name: "D",
              slots: [k("2026-08-25", 990), k("2026-08-26", 540)],
            },
          ],
          1
        )
        .every((b) => b.endMinute <= W.endMinute)
    );

    // ---- dragging ---------------------------------------------------
    // A drag is a RECTANGLE. Following reading order instead would
    // select the rest of Tuesday, all of Wednesday, and Thursday up to
    // the release — which is never what someone painting a grid means.
    const rect = sch.dragRect(
      W,
      { day: "2026-08-25", minute: 540 },
      { day: "2026-08-26", minute: 600 }
    );
    check("dragRect covers both days", rect.length === 6);
    check(
      "dragRect does not spill past the released row",
      rect.every((key) => sch.parseSlotKey(key).minute <= 600)
    );
    check(
      "dragging backwards covers the same cells",
      sch
        .dragRect(W, { day: "2026-08-26", minute: 600 }, { day: "2026-08-25", minute: 540 })
        .slice()
        .sort()
        .join() === rect.slice().sort().join()
    );
    check(
      "a drag from a day not on offer selects nothing",
      sch.dragRect(W, { day: "2026-01-01", minute: 540 }, { day: "2026-08-25", minute: 540 })
        .length === 0
    );

    check(
      "applyDrag adds without disturbing what was there",
      sch
        .applyDrag([k("2026-08-25", 900)], rect, "add")
        .includes(k("2026-08-25", 900))
    );
    check(
      "applyDrag removes only what the drag covered",
      (() => {
        const before = [...rect, k("2026-08-25", 900)];
        const after = sch.applyDrag(before, rect, "remove");
        return after.join() === k("2026-08-25", 900);
      })()
    );
    check(
      "applyDrag does not double up a cell already marked",
      sch.applyDrag(rect, rect, "add").length === rect.length
    );
    check(
      "applyDrag does not mutate the list it was given",
      (() => {
        const before = [k("2026-08-25", 540)];
        sch.applyDrag(before, rect, "add");
        return before.length === 1;
      })()
    );

    // ---- the NPC record template -----------------------------------
    // The DM's own layout. Everything here is one property said five
    // ways: a field cannot go missing. A template outlives the column
    // list it was built from, and a field the template forgets is not
    // missing from a tab — it is missing from the app, in every record
    // in the campaign, with no screen that would show you.
    const tplOut = compile("components/npcTemplate.ts");
    const tpl = await import(
      pathToFileURL(join(tplOut, "npcTemplate.js")).href
    );

    const KEYS = ["a", "b", "c", "d", "e"];
    const base = tpl.defaultTemplate(
      [
        { id: "one", title: "One", keys: ["a", "b"] },
        { id: "two", title: "Two", keys: ["c", "d", "e"] },
      ],
      ["e"]
    );

    check(
      "defaultTemplate keeps the sections it is given",
      base.tabs.length === 2 && tpl.templateKeys(base).join() === "a,b,c,d,e"
    );
    check(
      "defaultTemplate widens the fields it is told are wide",
      base.tabs[1].fields.find((f) => f.key === "e").span === 4 &&
        base.tabs[0].fields[0].span === 1
    );
    check(
      "and gives them a second row, since prose needs the height",
      base.tabs[1].fields.find((f) => f.key === "e").rows === 2 &&
        base.tabs[0].fields[0].rows === 1
    );

    // ---- hiding a field, which is not removing it ------------------
    // A field the template does not MENTION is one reconcileTemplate
    // puts straight back on the next load, so removal cannot hide
    // anything — and it would leave the field with no row in the
    // editor, which is a field nobody can bring back. Hidden keeps its
    // tab, its place and its size.
    const hiddenField = tpl.setFieldHidden(base, "c", true);
    check(
      "hiding marks the field",
      hiddenField.tabs[1].fields.find((f) => f.key === "c").hidden === true
    );
    check(
      "hiding leaves it exactly where it was",
      tpl.templateKeys(hiddenField).join() === tpl.templateKeys(base).join()
    );
    check(
      "hiding touches nothing else",
      hiddenField.tabs[1].fields.filter((f) => f.hidden).length === 1
    );
    check("hiddenKeys names it", tpl.hiddenKeys(hiddenField).join() === "c");
    check("and nothing when nothing is hidden", tpl.hiddenKeys(base).length === 0);

    // Un-hiding drops the flag rather than storing `false` on every
    // field of every layout forever.
    const shownAgain = tpl.setFieldHidden(hiddenField, "c", false);
    check(
      "un-hiding clears the flag entirely",
      shownAgain.tabs[1].fields.find((f) => f.key === "c").hidden === undefined
    );
    check("un-hiding is a real round trip", tpl.hiddenKeys(shownAgain).length === 0);

    check(
      "hiding a key the layout does not hold changes nothing",
      tpl.hiddenKeys(tpl.setFieldHidden(base, "nope", true)).length === 0
    );

    // The one that would look like the hide silently failing to save.
    check(
      "hidden survives a round trip through reconcile",
      tpl
        .hiddenKeys(tpl.reconcileTemplate(hiddenField, KEYS))
        .join() === "c"
    );
    check(
      "a hidden field is not treated as missing and re-added",
      tpl.reconcileTemplate(hiddenField, KEYS).tabs.flatMap((t) => t.fields)
        .filter((f) => f.key === "c").length === 1
    );
    check(
      "hiding still keeps it out of nobody's way — it stays placed",
      tpl.templateKeys(tpl.reconcileTemplate(hiddenField, KEYS)).sort().join() ===
        KEYS.slice().sort().join()
    );

    // ---- rows ------------------------------------------------------
    // The point of a row span is alignment: a two-row field beside two
    // one-row fields. That only works if rows are a fixed track, which
    // is a CSS fact the model cannot check — what it CAN guarantee is
    // that the number is always a usable one.
    check(
      "a field stored before rows existed gets one row, not NaN",
      tpl
        .reconcileTemplate(
          { tabs: [{ id: "x", title: "X", fields: [{ key: "a", span: 1 }] }] },
          ["a"]
        )
        .tabs[0].fields[0].rows === 1
    );
    check(
      "rows outside 1-6 are clamped",
      tpl
        .reconcileTemplate(
          {
            tabs: [
              {
                id: "x",
                title: "X",
                fields: [
                  { key: "a", span: 1, rows: 99 },
                  { key: "b", span: 1, rows: 0 },
                ],
              },
            ],
          },
          ["a", "b"]
        )
        .tabs[0].fields.map((f) => f.rows)
        .join() === "6,1"
    );
    check(
      "setRows clamps too",
      tpl.setRows(base, "a", 99).tabs[0].fields[0].rows === tpl.MAX_ROWS &&
        tpl.setRows(base, "a", -3).tabs[0].fields[0].rows === tpl.MIN_ROWS
    );
    check(
      "setRows leaves the width alone",
      tpl.setRows(base, "e", 3).tabs[1].fields.find((f) => f.key === "e")
        .span === 4
    );
    check(
      "setSpan leaves the height alone",
      tpl.setSpan(base, "e", 2).tabs[1].fields.find((f) => f.key === "e")
        .rows === 2
    );
    check(
      "moveField carries the height with the field",
      tpl.moveField(base, "e", "one", 0).tabs[0].fields[0].rows === 2
    );

    // ---- reconcileTemplate -----------------------------------------
    check(
      "reconcile is idempotent",
      eq(
        tpl.reconcileTemplate(tpl.reconcileTemplate(base, KEYS), KEYS),
        tpl.reconcileTemplate(base, KEYS)
      )
    );
    check(
      "a field the template never heard of is placed, not dropped",
      tpl
        .templateKeys(tpl.reconcileTemplate(base, [...KEYS, "brandNew"]))
        .includes("brandNew")
    );
    check(
      "a field whose column is gone is dropped",
      !tpl
        .templateKeys(tpl.reconcileTemplate(base, ["a", "b", "c"]))
        .includes("e")
    );
    check(
      "a key placed twice is kept once",
      tpl
        .templateKeys(
          tpl.reconcileTemplate(
            { tabs: [{ id: "x", title: "X", fields: [{ key: "a", span: 1 }, { key: "a", span: 2 }] }] },
            ["a"]
          )
        )
        .join() === "a"
    );
    check(
      "a span outside 1–4 is clamped, not honoured",
      tpl
        .reconcileTemplate(
          { tabs: [{ id: "x", title: "X", fields: [{ key: "a", span: 99 }, { key: "b", span: 0 }] }] },
          ["a", "b"]
        )
        .tabs[0].fields.map((f) => f.span)
        .join() === "4,1"
    );
    check(
      "a span that is not a number becomes one column",
      tpl
        .reconcileTemplate(
          { tabs: [{ id: "x", title: "X", fields: [{ key: "a", span: "wide" }] }] },
          ["a"]
        )
        .tabs[0].fields[0].span === 1
    );
    check(
      "nothing at all still renders something",
      tpl.reconcileTemplate(null, []).tabs.length === 1
    );
    check(
      "an empty template still places every field",
      tpl.templateKeys(tpl.reconcileTemplate({ tabs: [] }, KEYS)).sort().join() ===
        KEYS.join()
    );
    check(
      "two tabs cannot share an id",
      (() => {
        const r = tpl.reconcileTemplate(
          {
            tabs: [
              { id: "same", title: "A", fields: [] },
              { id: "same", title: "B", fields: [{ key: "a", span: 1 }] },
            ],
          },
          ["a"]
        );
        return new Set(r.tabs.map((t) => t.id)).size === r.tabs.length;
      })()
    );
    check(
      "a tab with no name gets one",
      tpl
        .reconcileTemplate({ tabs: [{ id: "x", title: "   ", fields: [] }] }, [])
        .tabs[0].title === "Tab 1"
    );

    // ---- moving things ---------------------------------------------
    const moved = tpl.moveField(base, "a", "two", 0);
    check(
      "moveField takes the field out of the tab it was in",
      !moved.tabs[0].fields.some((f) => f.key === "a")
    );
    check(
      "moveField puts it where it was asked to",
      moved.tabs[1].fields[0].key === "a"
    );
    check(
      "moveField keeps every field",
      tpl.templateKeys(moved).sort().join() === KEYS.join()
    );
    check(
      "moveField carries the width with the field",
      tpl.moveField(base, "e", "one", 0).tabs[0].fields[0].span === 4
    );
    check(
      "an index past the end lands at the end, not off it",
      tpl.moveField(base, "a", "two", 999).tabs[1].fields.at(-1).key === "a"
    );

    check(
      "shiftField reorders within the tab",
      tpl.shiftField(base, "b", -1).tabs[0].fields.map((f) => f.key).join() ===
        "b,a"
    );
    check(
      "shiftField at the edge does nothing rather than wrapping",
      eq(tpl.shiftField(base, "a", -1), base)
    );
    check(
      "setSpan clamps",
      tpl.setSpan(base, "a", 40).tabs[0].fields[0].span === 4
    );

    // ---- tabs -------------------------------------------------------
    const withSecrets = tpl.addTab(base, "Secrets");
    check(
      "addTab appends an empty tab",
      withSecrets.tabs.at(-1).fields.length === 0
    );
    check(
      "addTab gives a unique id even for a repeated name",
      (() => {
        const twice = tpl.addTab(tpl.addTab(base, "Notes"), "Notes");
        return new Set(twice.tabs.map((t) => t.id)).size === twice.tabs.length;
      })()
    );
    check(
      "addTab stops at the limit",
      (() => {
        let t = base;
        for (let i = 0; i < 50; i++) t = tpl.addTab(t, `T${i}`);
        return t.tabs.length === tpl.TEMPLATE_LIMITS.tabs;
      })()
    );
    check(
      "renameTab does not move the fields out of it",
      tpl.renameTab(base, "one", "Renamed").tabs[0].fields.length === 2
    );

    // Removing a tab must not remove an evening's arranging with it.
    const removed = tpl.removeTab(base, "one");
    check(
      "removeTab keeps the fields that were in it",
      tpl.templateKeys(removed).sort().join() === KEYS.join()
    );
    check("removeTab removes the tab", removed.tabs.length === 1);
    check(
      "the last tab cannot be removed",
      eq(
        tpl.removeTab({ tabs: [base.tabs[0]] }, "one"),
        { tabs: [base.tabs[0]] }
      )
    );
    check(
      "shiftTab reorders the strip",
      tpl.shiftTab(base, "two", -1).tabs.map((t) => t.id).join() === "two,one"
    );
    check(
      "shiftTab at the edge does nothing",
      eq(tpl.shiftTab(base, "one", -1), base)
    );

    // ---- what a player is shown ------------------------------------
    // Same rule as the sections: a tab a viewer has no fields for is
    // not rendered empty. The outline of what was withheld is still
    // information.
    const forPlayerTabs = tpl.templateFor(base, ["a", "b"]);
    check(
      "templateFor drops a tab the viewer has nothing in",
      forPlayerTabs.length === 1 && forPlayerTabs[0].id === "one"
    );
    check(
      "templateFor keeps the fields they do get",
      forPlayerTabs[0].fields.map((f) => f.key).join() === "a,b"
    );
    check(
      "templateFor does not mutate the template it was given",
      tpl.templateKeys(base).join() === "a,b,c,d,e"
    );
    check("templateFor on nothing is nothing", tpl.templateFor(base, []).length === 0);

    // ---- the locations tree ----------------------------------------
    // Everything here is about not losing a place: a player's list has
    // the hidden locations filtered out of it, so their children
    // routinely have no parent to sit under and must not vanish with it.
    const locOut = compile("components/locationTree.ts");
    const loc = await import(
      pathToFileURL(join(locOut, "locationTree.js")).href
    );

    const place = (id, parentId, order = 0, extra = {}) => ({
      _id: id,
      parentId,
      name: id,
      order,
      ...extra,
    });

    const atlas = [
      place("region", null, 0),
      place("city", "region", 1),
      place("town", "region", 0),
      place("district", "city", 0),
    ];

    check(
      "childrenOf returns a place's children in order",
      loc.childrenOf(atlas, "region").map((r) => r._id).join() === "town,city"
    );
    check(
      "childrenOf(null) returns the roots",
      loc.childrenOf(atlas, null).map((r) => r._id).join() === "region"
    );
    check(
      "a child whose parent was filtered out surfaces at the root",
      loc
        .childrenOf(
          [place("district", "city-the-player-cannot-see", 0)],
          null
        )
        .map((r) => r._id)
        .join() === "district"
    );

    check(
      "ancestorsOf is the breadcrumb, root first",
      loc.ancestorsOf(atlas, "district").map((r) => r._id).join() ===
        "region,city,district"
    );
    check(
      "ancestorsOf terminates on a cycle",
      loc.ancestorsOf([place("a", "b"), place("b", "a")], "a").length === 2
    );

    check(
      "wouldCycle: under yourself",
      loc.wouldCycle(atlas, "region", "region")
    );
    check(
      "wouldCycle: under your own descendant",
      loc.wouldCycle(atlas, "region", "district")
    );
    check(
      "wouldCycle: a legitimate move is allowed",
      !loc.wouldCycle(atlas, "town", "city")
    );
    check(
      "wouldCycle: moving to the root is always allowed",
      !loc.wouldCycle(atlas, "district", null)
    );

    check(
      "deleting promotes children to the deleted place's parent",
      eq(loc.reparentOnDelete(atlas, "city"), [
        { _id: "district", parentId: "region" },
      ])
    );
    check(
      "deleting a root promotes its children to the root",
      eq(loc.reparentOnDelete(atlas, "region"), [
        { _id: "town", parentId: null },
        { _id: "city", parentId: null },
      ])
    );

    check(
      "flatten reads as a tree, depth-first",
      loc
        .flatten(atlas)
        .map((n) => `${" ".repeat(n.depth)}${n.row._id}`)
        .join("|") === "region| town| city|  district"
    );
    check(
      "flatten terminates on a cycle",
      loc.flatten([place("a", "b"), place("b", "a")]).length <= 2
    );

    check("hasMap: an uploaded map", loc.hasMap({ mapUrl: "https://x/y.png" }));
    check("hasMap: an imported path", loc.hasMap({ mapPath: "web/maps/x.webp" }));
    check("hasMap: neither", !loc.hasMap({ mapUrl: null, mapPath: null }));

    check(
      "mapSrc prefers the uploaded file over the imported path",
      loc.mapSrc("https://up/a.png", "web/b.webp", "https://maps") ===
        "https://up/a.png"
    );
    check(
      "mapSrc falls back to the map server",
      loc.mapSrc(null, "web/b.webp", "https://maps") === "https://maps/web/b.webp"
    );
    check(
      "mapSrc without a map server does not build a relative URL",
      loc.mapSrc(null, "web/b.webp", "") === null
    );

    check("clampPin: below zero", loc.clampPin(-0.5) === 0);
    check("clampPin: above one", loc.clampPin(1.5) === 1);
    check("clampPin: NaN", loc.clampPin(Number.NaN) === 0);

    // ---- Lookup formatting -----------------------------------------
    // Challenge rating and spell level are both small integers that
    // mean something other than themselves, and either read wrong is
    // the sort of thing you only notice at the table.
    const lookOut = compile("components/lookupFields.ts");
    const look = await import(
      pathToFileURL(join(lookOut, "lookupFields.js")).href
    );

    check("formatCr: a fractional CR reads as a fraction", look.formatCr(0.25) === "1/4");
    check("formatCr: an eighth", look.formatCr(0.125) === "1/8");
    check("formatCr: a half", look.formatCr(0.5) === "1/2");
    check("formatCr: zero is not nothing", look.formatCr(0) === "0");
    check("formatCr: a whole number", look.formatCr(17) === "17");
    check("formatCr: absent stays absent", look.formatCr(undefined) === null);

    check("formatSpellLevel: level 0 is a cantrip", look.formatSpellLevel(0) === "Cantrip");
    check("formatSpellLevel: 1st", look.formatSpellLevel(1) === "1st");
    check("formatSpellLevel: 2nd", look.formatSpellLevel(2) === "2nd");
    check("formatSpellLevel: 3rd", look.formatSpellLevel(3) === "3rd");
    check("formatSpellLevel: 9th", look.formatSpellLevel(9) === "9th");
    check(
      "formatSpellLevel: absent stays absent",
      look.formatSpellLevel(null) === null
    );

    // The stat block prints score and modifier; the modifier floors
    // toward negative infinity, so an odd score below 10 must not round
    // the wrong way — 9 is -1, not 0.
    check("abilityModifier: 21 is +5", look.abilityModifier(21) === "+5");
    check("abilityModifier: 10 is +0", look.abilityModifier(10) === "+0");
    check("abilityModifier: 11 is +0", look.abilityModifier(11) === "+0");
    check("abilityModifier: 9 is -1", look.abilityModifier(9) === "-1");
    check("abilityModifier: 8 is -1", look.abilityModifier(8) === "-1");
    check("abilityModifier: 6 is -2", look.abilityModifier(6) === "-2");
    check("abilityModifier: 1 is -5", look.abilityModifier(1) === "-5");
    check("abilityModifier: absent", look.abilityModifier(undefined) === null);

    const cells = look.abilityCells({ str: 21, dex: 8, cha: 8 });
    check(
      "abilityCells keeps the printed order and skips what is missing",
      cells.map((c) => c.label).join() === "STR,DEX,CHA"
    );
    check("abilityCells carries the modifier", cells[0].modifier === "+5");
    check("abilityCells: nothing at all", look.abilityCells({}).length === 0);
    check("abilityCells: not an object", look.abilityCells(null).length === 0);

    // Items: the italic line under the name.
    check(
      "itemSubtitle reads as prose, with rarity lower-cased mid-sentence",
      look.itemSubtitle({
        kind: "wondrous",
        rarity: "Very Rare",
        attunement: true,
      }) === "Wondrous Item, very rare (requires attunement)"
    );
    check(
      "itemSubtitle without attunement",
      look.itemSubtitle({ kind: "weapon", rarity: "Rare" }) === "Weapon, rare"
    );
    check(
      "itemSubtitle with no rarity at all",
      look.itemSubtitle({ kind: "gear" }) === "Adventuring Gear"
    );

    // Spells: eight cells, always eight.
    const sc = look.spellCells({ level: 8, school: "Necromancy" });
    check("spellCells always has eight slots", sc.length === 8);
    check(
      "a missing cell keeps its slot rather than collapsing the grid",
      sc.every((c) => typeof c.value === "string" && c.value.length > 0)
    );
    check(
      "spellRangeArea joins the range and the shape it fills",
      look.spellRangeArea({ range: "150 ft", area: "20 ft Sphere" }) ===
        "150 ft (20 ft Sphere)"
    );
    check(
      "spellRangeArea with only a range",
      look.spellRangeArea({ range: "Touch" }) === "Touch"
    );
    check(
      "concentration rides on the duration",
      look.spellDuration({ duration: "1 minute", concentration: true }) ===
        "Concentration, 1 minute"
    );

    // Monsters.
    check(
      "monsterSubtitle reads as the stat block prints it",
      look.monsterSubtitle({
        size: "Large",
        creatureType: "Giant",
        alignment: "Chaotic Neutral",
      }) === "Large Giant, Chaotic Neutral"
    );
    check(
      "monsterChallenge prints the XP beside the rating",
      look.monsterChallenge({ cr: 8, xp: 3900 }) === "8 (3,900 XP)"
    );
    check(
      "monsterChallenge without XP",
      look.monsterChallenge({ cr: 0.25 }) === "1/4"
    );
    // A proficiency bonus is already a bonus. Running it through the
    // ability-modifier formula would print +3 as +1.
    check("signed: a positive bonus", look.signed(3) === "+3");
    check("signed: zero", look.signed(0) === "+0");
    check("signed: a negative bonus", look.signed(-2) === "-2");
    check(
      "the proficiency bonus prints signed",
      look
        .monsterTraitLines({ proficiencyBonus: 3 })
        .some((l) => l.label === "Proficiency Bonus" && l.value === "+3")
    );
    check(
      "monsterTraitLines omits what the import never carried",
      look.monsterTraitLines({}).length === 0
    );

    check(
      "features survives a row that carried none",
      look.features(undefined).length === 0 && look.features("nope").length === 0
    );
    check(
      "features drops an entry with no name",
      look.features([{ text: "x" }, { name: "Two Heads", text: "y" }])
        .length === 1
    );

    // The table's columns: every one must render on a nearly empty row,
    // because a sparse import is the normal case rather than the
    // exception, and a column that throws takes the whole screen down.
    for (const kind of ["spells", "items", "monsters"]) {
      const cols = look.LOOKUP_COLUMNS[kind];
      check(`${kind} declares columns`, cols.length > 0);
      check(
        `${kind} column keys are unique`,
        new Set(cols.map((c) => c.key)).size === cols.length
      );
      check(
        `${kind} has exactly one primary column`,
        cols.filter((c) => c.primary).length === 1
      );
      let ok = true;
      for (const c of cols) {
        try {
          c.get({});
          if (c.sort) c.sort({});
        } catch {
          ok = false;
        }
      }
      check(`${kind} columns survive an empty row`, ok);
      // The grid template must have a track per column plus the expand
      // button, or the header and the rows stop lining up.
      const tracks = (t) => t.trim().split(/\s+(?![^(]*\))/).length;
      check(
        `${kind} template has a track per column plus the button`,
        tracks(look.columnTemplate(kind)) >= cols.length + 1
      );

      // Resizing must never change the NUMBER of tracks. The header and
      // the rows are separate grids that only line up because they are
      // handed the same template; a width that added or dropped a track
      // would slide every column out from under its heading.
      const pinned = Object.fromEntries(cols.map((c) => [c.key, 140]));
      check(
        `${kind} keeps its track count when every column is resized`,
        tracks(look.columnTemplate(kind, pinned)) ===
          tracks(look.columnTemplate(kind))
      );
      check(
        `${kind} keeps its track count when one column is resized`,
        tracks(look.columnTemplate(kind, { [cols[0].key]: 140 })) ===
          tracks(look.columnTemplate(kind))
      );
      // Pinning everything leaves nothing to absorb the leftover width,
      // so the button's track has to stretch — otherwise the row stops
      // short of the table's edge with the button stranded mid-row.
      check(
        `${kind} gives the slack to the button once nothing else flexes`,
        look.columnTemplate(kind, pinned).endsWith("minmax(2.25rem, 1fr)")
      );
      check(
        `${kind} leaves the button track alone while a column still flexes`,
        look.columnTemplate(kind).endsWith(" 2.25rem")
      );
    }

    // A resized column is a pixel track; an untouched one keeps what it
    // was declared with, so an account that has never dragged anything
    // sees the designed table.
    const withWidth = look.columnTemplate("items", { rarity: 200 });
    check("a resized column becomes a pixel track", withWidth.includes("200px"));
    check(
      "an untouched column keeps its declared track",
      withWidth.includes("minmax(11rem, 2fr)")
    );
    check(
      "a width below the minimum is clamped, not obeyed",
      look
        .columnTemplate("items", { rarity: 4 })
        .includes(`${look.MIN_LOOKUP_COL}px`)
    );
    check(
      "a fractional drag lands on a whole pixel",
      look.columnTemplate("items", { rarity: 199.6 }).includes("200px")
    );
    // Nothing here may throw on junk: these widths come back from a
    // stored document, which is the one input this code cannot type-check.
    check(
      "a NaN width is ignored rather than written into the template",
      !look.columnTemplate("items", { rarity: Number.NaN }).includes("NaN")
    );
    check(
      "a width for a column that no longer exists is harmless",
      look.columnTemplate("items", { gone: 300 }) ===
        look.columnTemplate("items")
    );
    check(
      "no widths at all is the same as none",
      look.columnTemplate("items", null) === look.columnTemplate("items")
    );

    // Sorting is by COLUMN now, and a column's display form is not
    // always its order: CR "1/4" sits between "1/8" and "1/2" only as a
    // number, and rarity is an order nobody would guess alphabetically.
    const mons = [
      { name: "Ettin", cr: 8 },
      { name: "Kobold", cr: 0.125 },
      { name: "Aarakocra", cr: 0.25 },
      { name: "Mystery", cr: null },
    ];
    check(
      "CR sorts numerically, and an unknown CR sorts last",
      eq(
        look.sortByColumn("monsters", mons, "cr", false).map((r) => r.name),
        ["Kobold", "Aarakocra", "Ettin", "Mystery"]
      )
    );
    check(
      "descending reverses it",
      look.sortByColumn("monsters", mons, "cr", true)[0].name === "Mystery"
    );
    check(
      "name is the tiebreak, so equal values keep a meaningful order",
      eq(
        look
          .sortByColumn(
            "monsters",
            [
              { name: "Zed", cr: 1 },
              { name: "Amy", cr: 1 },
            ],
            "cr",
            false
          )
          .map((r) => r.name),
        ["Amy", "Zed"]
      )
    );
    check(
      "rarity sorts by the printed order, not alphabetically",
      eq(
        look
          .sortByColumn(
            "items",
            [
              { name: "a", rarity: "Legendary" },
              { name: "b", rarity: "Common" },
              { name: "c", rarity: "Rare" },
            ],
            "rarity",
            false
          )
          .map((r) => r.rarity),
        ["Common", "Rare", "Legendary"]
      )
    );
    check(
      "an unknown sort key falls back to name rather than throwing",
      look.sortByColumn("items", [{ name: "b" }, { name: "a" }], "nope", false)[0]
        .name === "a"
    );

    // ---- where a row's artwork is fetched from ----------------------
    // The same stored path has to work against the map server and
    // against the app's own public/ directory, because standing up the
    // map server later must not mean re-importing 7,361 rows.
    check(
      "with a map server, the path hangs off it",
      look.artSrc("web/foundry/icons/a.webp", "https://maps.example.com") ===
        "https://maps.example.com/web/foundry/icons/a.webp"
    );
    check(
      "with no map server, the path is root-relative to the app",
      look.artSrc("web/foundry/icons/a.webp", undefined) ===
        "/web/foundry/icons/a.webp"
    );
    check(
      "an unset env var reads as empty, not as the string 'undefined'",
      look.artSrc("web/foundry/icons/a.webp", "") === "/web/foundry/icons/a.webp"
    );
    // "//web/foundry/..." is PROTOCOL-relative: the browser reads "web"
    // as a hostname and leaves the app. A trailing slash in .env.local
    // is the likeliest way to get one.
    check(
      "a trailing slash on the map server does not make a protocol-relative url",
      look.artSrc("web/foundry/icons/a.webp", "https://maps.example.com/") ===
        "https://maps.example.com/web/foundry/icons/a.webp"
    );
    check(
      "a leading slash on the stored path does not either",
      look.artSrc("/web/foundry/icons/a.webp", "") === "/web/foundry/icons/a.webp"
    );
    check("no image is no src", look.artSrc(undefined, "https://m") === null);
    check("an empty image is no src", look.artSrc("   ", "https://m") === null);
    check("a non-string image is no src", look.artSrc(42, "https://m") === null);

    // ---- the Lookup filters ----------------------------------------
    // These run in the browser on every keystroke, so a wrong rule
    // silently HIDES rows rather than erroring — the failure mode is a
    // short list nobody can explain.
    const filtOut = compile("components/lookupFilters.ts");
    const filt = await import(
      pathToFileURL(join(filtOut, "lookupFilters.js")).href
    );

    // ---- editions --------------------------------------------------
    // A DDB import carries both printings of the core books, so most
    // core entries exist twice under one name. Getting this wrong makes
    // rows VANISH with no error — the worst failure this screen has.
    check("2024 core book", filt.editionOf("PHB 2024") === "2024");
    check("2024 monster manual", filt.editionOf("MM 2024") === "2024");
    check("2024 SRD", filt.editionOf("SRD 2024") === "2024");
    check("2014 core book", filt.editionOf("PHB") === "2014");
    check("the 2014 SRD is not 2024", filt.editionOf("SRD 5.1") === "2014");
    check("a supplement is 2014-era", filt.editionOf("TCoE") === "2014");
    check("an adventure is 2014-era", filt.editionOf("IDRotF") === "2014");
    check("a missing source is 2014-era", filt.editionOf(undefined) === "2014");
    check("a non-string source", filt.editionOf(2024) === "2014");
    // The year is anchored to the END. A loose search would reclassify
    // a book that merely has 2024 somewhere in its name.
    check(
      "a year inside the title does not make it 2024",
      filt.editionOf("Best of 2024 Adventures") === "2014"
    );
    check("no false match on 12024", filt.editionOf("Vault 12024") === "2014");

    const library = [
      { name: "Longsword", source: "PHB" },
      { name: "Longsword", source: "PHB 2024" },
      { name: "Aboleth", source: "MM" },
      { name: "Aboleth", source: "MM 2024" },
      { name: "Rod of Absorption", source: "DMG 2024" },
      { name: "Amulet of the Devout", source: "TCoE" },
      { name: "Dragon of Icespire Peak", source: "DIP" },
    ];
    const names = (ed) =>
      filt.applyEdition(library, ed).map((r) => `${r.name}/${r.source}`);

    check(
      "5.5e keeps the 2024 half of every duplicate",
      eq(names("2024"), [
        "Longsword/PHB 2024",
        "Aboleth/MM 2024",
        "Rod of Absorption/DMG 2024",
        "Amulet of the Devout/TCoE",
        "Dragon of Icespire Peak/DIP",
      ])
    );
    check(
      "5e keeps the older half of every duplicate",
      eq(names("2014"), [
        "Longsword/PHB",
        "Aboleth/MM",
        "Rod of Absorption/DMG 2024",
        "Amulet of the Devout/TCoE",
        "Dragon of Icespire Peak/DIP",
      ])
    );
    // The two properties that make this a dedupe rather than a filter.
    check(
      "a 2024-only entry survives a 5e campaign",
      names("2014").includes("Rod of Absorption/DMG 2024")
    );
    check(
      "a supplement survives a 5.5e campaign",
      names("2024").includes("Amulet of the Devout/TCoE")
    );
    check(
      "neither edition loses a name entirely",
      new Set(filt.applyEdition(library, "2014").map((r) => r.name)).size ===
        new Set(library.map((r) => r.name)).size &&
        new Set(filt.applyEdition(library, "2024").map((r) => r.name)).size ===
          new Set(library.map((r) => r.name)).size
    );
    check(
      "input order is preserved",
      eq(
        filt.applyEdition(
          [
            { name: "Zed", source: "PHB" },
            { name: "Amy", source: "PHB" },
          ],
          "2014"
        ).map((r) => r.name),
        ["Zed", "Amy"]
      )
    );
    check(
      "names match regardless of case and spacing",
      filt.applyEdition(
        [
          { name: "Bag of  Holding", source: "DMG" },
          { name: "bag of holding", source: "DMG 2024" },
        ],
        "2024"
      ).length === 1
    );
    check("an empty library stays empty", filt.applyEdition([], "2024").length === 0);
    check(
      "three printings of one name still collapse to the wanted ones",
      filt.applyEdition(
        [
          { name: "Fireball", source: "PHB" },
          { name: "Fireball", source: "SRD 5.1" },
          { name: "Fireball", source: "PHB 2024" },
        ],
        "2024"
      ).length === 1
    );
    check(
      "and a 5e campaign keeps both of its own printings",
      filt.applyEdition(
        [
          { name: "Fireball", source: "PHB" },
          { name: "Fireball", source: "SRD 5.1" },
          { name: "Fireball", source: "PHB 2024" },
        ],
        "2014"
      ).length === 2
    );

    check(
      "both editions are offered where someone has to choose",
      eq(
        filt.RULES_VERSIONS.map((r) => r.value),
        ["2014", "2024"]
      ) && filt.RULES_VERSIONS.every((r) => r.label && r.note)
    );

    // An empty value is not a filter, and must never match-fail.
    check("empty: undefined", filt.isEmptyValue(undefined));
    check("empty: blank string", filt.isEmptyValue("   "));
    check("empty: empty array", filt.isEmptyValue([]));
    check("empty: an unset toggle", filt.isEmptyValue(false));
    check("empty: an unset range", filt.isEmptyValue({ min: "", max: "" }));
    check("not empty: a set toggle", !filt.isEmptyValue(true));
    check("not empty: one bound", !filt.isEmptyValue({ min: "5", max: "" }));
    check("not empty: a picked option", !filt.isEmptyValue(["Rare"]));

    check("contains is case-insensitive", filt.contains("Fireball", "fire"));
    check("contains ignores surrounding space", filt.contains("Fireball", " BALL "));
    check("contains on a missing field", !filt.contains(undefined, "x"));

    check("inRange: inside", filt.inRange(15, { min: "10", max: "20" }));
    check("inRange: on the lower bound", filt.inRange(10, { min: "10", max: "20" }));
    check("inRange: on the upper bound", filt.inRange(20, { min: "10", max: "20" }));
    check("inRange: below", !filt.inRange(9, { min: "10", max: "20" }));
    check("inRange: open upper bound", filt.inRange(999, { min: "10", max: "" }));
    check("inRange: fractional CR", filt.inRange(0.25, { min: "0", max: "1" }));
    // A row the import never carried a value for must not sneak into a
    // bounded range — "AC 15 to 20" should not return unknown ACs.
    check("inRange: a missing value fails", !filt.inRange(undefined, { min: "1", max: "99" }));

    // Applying them.
    const spellRows = [
      { name: "Fireball", level: 3, school: "Evocation", components: "V, S, M", ritual: false, concentration: false, attackSave: "DEX Save", damageEffect: "Fire" },
      { name: "Detect Magic", level: 1, school: "Divination", components: "V, S", ritual: true, concentration: true, attackSave: null, damageEffect: null },
      { name: "Fire Bolt", level: 0, school: "Evocation", components: "V, S", ritual: false, concentration: false, attackSave: "Ranged", damageEffect: "Fire" },
    ];
    const apply = (state) => filt.applyFilters("spells", spellRows, state).map((r) => r.name);

    check("no filters returns everything", apply({}).length === 3);
    check("an empty filter is not a filter", apply({ name: "  " }).length === 3);
    check("name matches a substring", eq(apply({ name: "fire" }), ["Fireball", "Fire Bolt"]));
    check("level is any-of", eq(apply({ level: ["0", "3"] }), ["Fireball", "Fire Bolt"]));
    check("school is any-of", eq(apply({ school: ["Divination"] }), ["Detect Magic"]));
    check("a toggle filters to only those", eq(apply({ ritual: true }), ["Detect Magic"]));
    check(
      "two filters are AND, not OR",
      eq(apply({ name: "fire", level: ["0"] }), ["Fire Bolt"])
    );
    // "V and S and M" is a narrower question than "V or S or M", and
    // the narrower one is what a row of pressed pills looks like.
    check(
      "components are ALL-of, not any-of",
      eq(apply({ components: ["V", "S", "M"] }), ["Fireball"])
    );
    check(
      "a save filter matches inside 'DEX Save'",
      eq(apply({ save: ["DEX"] }), ["Fireball"])
    );
    check(
      "attack type is exact, so a save is not a ranged attack",
      eq(apply({ attack: "Ranged" }), ["Fire Bolt"])
    );

    check("activeCount counts only what is set", filt.activeCount("spells", { name: "x", level: [] }) === 1);
    check(
      "hasActiveAdvanced sees a hidden filter",
      filt.hasActiveAdvanced("spells", { ritual: true }) === true &&
        filt.hasActiveAdvanced("spells", { name: "x" }) === false
    );

    // Every declared filter must be reachable and total.
    for (const kind of ["spells", "items", "monsters"]) {
      const defs = filt.FILTERS[kind];
      check(`${kind} declares filters`, defs.length > 0);
      check(
        `${kind} filter keys are unique`,
        new Set(defs.map((d) => d.key)).size === defs.length
      );
      let ok = true;
      for (const def of defs) {
        // A matcher is never asked about an empty value, but it must
        // survive a row that carries none of its fields.
        const sample =
          def.control.type === "range"
            ? { min: "1", max: "2" }
            : def.control.type === "toggle"
              ? true
              : def.control.type === "multi"
                ? [def.control.options[0].value]
                : def.control.type === "chips" || def.control.type === "select"
                  ? def.control.options[0].value
                  : "x";
        try {
          def.match({}, sample);
        } catch {
          ok = false;
        }
      }
      check(`${kind} matchers survive an empty row`, ok);
      check(
        `${kind} has at least one compact filter`,
        defs.some((d) => !d.advanced)
      );
    }

    // ---- command-line parsing ---------------------------------------
    // The regression this exists for: reading a flag's value as
    // `args[args.indexOf("--from") + 1]` returns args[0] when the flag
    // is ABSENT, because indexOf returns -1 — and the `?? default`
    // beside it never fires, because args[0] is a string. It shipped,
    // and built a Foundry URL out of the export's own filename.
    const { parseArgs } = await import(
      pathToFileURL(join(APP_ROOT, "scripts", "args.mjs")).href
    );

    const SPEC = {
      "-o": { value: true, default: "out" },
      "--from": { value: true, default: "http://localhost:30000" },
      "--force": {},
    };
    const parse = (...argv) => parseArgs(argv, SPEC);
    const threw = (...argv) => {
      try {
        parseArgs(argv, SPEC);
        return false;
      } catch {
        return true;
      }
    };

    check(
      "an absent value flag falls back to its default",
      parse("export.json")["flags"]["--from"] === "http://localhost:30000"
    );
    check(
      "an absent flag does not consume the first positional",
      parse("export.json")["flags"]["-o"] === "out"
    );
    check(
      "the positional is still the positional",
      eq(parse("export.json", "--force").positionals, ["export.json"])
    );
    check(
      "an absent switch is false, not undefined",
      parse("export.json").flags["--force"] === false
    );

    check(
      "a value flag reads the token after it",
      parse("f", "-o", "images").flags["-o"] === "images"
    );
    check(
      "the flag's value is not mistaken for a positional",
      eq(parse("f", "-o", "images").positionals, ["f"])
    );
    check(
      "--flag=value works too",
      parse("f", "--from=http://box:1234").flags["--from"] === "http://box:1234"
    );
    check(
      "a switch is true when present",
      parse("f", "--force").flags["--force"] === true
    );
    check(
      "flags may come before the positional",
      eq(parse("-o", "images", "f").positionals, ["f"])
    );

    // The failure modes that used to be silent.
    check("an unknown option is an error", threw("f", "--dryrun"));
    check("a value flag with nothing after it is an error", threw("f", "-o"));
    check(
      "a value flag followed by another flag is an error",
      threw("f", "--from", "--force")
    );
    check("a switch given a value is an error", threw("f", "--force=yes"));
    check(
      "a value that merely looks odd is still accepted",
      parse("f", "-o", "-weird-dir").flags["-o"] === "-weird-dir"
    );
    check("a bare - is a positional", eq(parse("-").positionals, ["-"]));
    check(
      "no arguments at all yields the defaults",
      parse().flags["-o"] === "out" && parse().positionals.length === 0
    );

    // ---- the Foundry converter -------------------------------------
    // Every case below was found in Derek's real 976-document export
    // rather than imagined, and each one produced visibly wrong text
    // before it was fixed. The script is plain .mjs, so it is run as a
    // subprocess over a fixture rather than imported.
    const fixture = [
      {
        _id: "s1",
        name: "Fireball",
        type: "spell",
        img: "icons/magic/fire/beam-jet-stream.webp",
        system: {
          level: 3,
          school: "evo",
          activation: { type: "action", value: 1, condition: "" },
          range: { value: "150", units: "ft" },
          duration: { value: "", units: "inst" },
          materials: { value: "a ball of bat guano and sulfur" },
          properties: ["vocal", "somatic", "material"],
          target: {
            affects: { type: "creature", count: "" },
            template: { type: "sphere", size: "20", units: "ft" },
          },
          source: { rules: "2024", book: "", custom: "" },
          description: {
            value:
              "<p>@labels.description.affects capitalize in a " +
              "@labels.description.template centered on that point makes a " +
              "Dexterity saving throw. It takes " +
              "[[/damage 8d6 fire average=false]] damage, and can be " +
              "&amp;Reference[Blinded apply=false] by it. Make an " +
              "[[/check ability=int skill=inv dc=@attributes.spell.dc]] check " +
              "against @attributes.spell.dc, using @item.level slots " +
              "(see @UUID[Compendium.dnd5e.x.y]{Gameplay Toolbox}).</p>",
          },
        },
      },
      {
        _id: "s2",
        name: "Animal Messenger",
        type: "spell",
        system: {
          level: 2,
          school: "enc",
          activation: { type: "minute", value: 10 },
          range: { value: "1", units: "mi" },
          duration: { value: "@item.level * 48 - 72", units: "hour" },
          properties: ["ritual", "concentration", "vocal"],
          description: { value: "<p>Plain.</p>" },
        },
      },
      {
        _id: "i1",
        name: "Berserker Axe",
        type: "weapon",
        img: "https://cdn.example.com/axe.png",
        system: {
          rarity: "veryRare",
          attunement: "required",
          attuned: false,
          price: { value: 4000, denomination: "gp" },
          weight: { value: 0, units: "lb" },
          type: { value: "martialM" },
          source: { rules: "2024" },
          // An item carries the same enricher a monster's weapon does,
          // with nobody to compute it against. Without this line the
          // "no invented attack line" check below passes vacuously —
          // it did, until a mutation test found nothing to break.
          description: {
            value: "<p>[[/attack extended]]. An axe.</p>",
          },
        },
      },
      {
        _id: "m1",
        name: "Ettin Test",
        type: "npc",
        prototypeToken: {},
        system: {
          details: {
            cr: 8,
            type: { value: "giant" },
            alignment: "Chaotic Neutral",
            habitat: { value: [{ type: "forest" }, { type: "underdark" }] },
            biography: { value: "<p>Two heads.</p>" },
          },
          traits: { size: "lg", languages: { value: ["giant", "orc"] } },
          attributes: {
            ac: { flat: 15, calc: "natural" },
            hp: { max: 123 },
            movement: { walk: 40, units: "ft" },
            senses: { units: "ft", ranges: { darkvision: 60 } },
          },
          abilities: { str: { value: 21 }, dex: { value: 8 } },
          skills: { prc: { value: 1 } },
        },
        items: [
          { name: "Chain Shirt", type: "equipment", system: { armor: { value: 13 } } },
          { name: "Two Heads", type: "feat", system: { description: { value: "<p>Advantage.</p>" } } },
          { name: "Morningstar", type: "weapon", system: { description: { value: "<p>Hit.</p>" } } },
          { name: "Lash", type: "feat", system: { activation: { type: "legendary" }, description: { value: "<p>Tail.</p>" } } },
        ],
      },
      {
        // Verbatim from Derek's export, and the case that showed the
        // attack line and the damage numbers are NOT in the file: Foundry
        // computes both from the activity and the actor at display time.
        // Stripped as text this read "Talons. extended. Hit: 1d4 +
        // damage" — no bonus, no reach, no average, no damage type.
        _id: "m3",
        name: "Aarakocra Skirmisher",
        type: "npc",
        prototypeToken: {},
        system: {
          details: { cr: 0.25, type: { value: "elemental" } },
          traits: { size: "med" },
          attributes: { ac: { flat: 12, calc: "natural" }, hp: { max: 11 } },
          abilities: {
            str: { value: 10 },
            dex: { value: 14 },
            con: { value: 12 },
          },
        },
        items: [
          {
            name: "Talons",
            type: "weapon",
            system: {
              description: {
                value:
                  "<p> [[/attack extended]]. <em>Hit:</em> [[/damage 1d4 + " +
                  "@abilities.dex.mod type=slashing average=true]] damage, " +
                  "or [[/damage 3d4 + @abilities.dex.mod type=slashing " +
                  "average=true]] damage if it moved 30+ feet.</p>",
              },
              activities: {
                a1: {
                  type: "attack",
                  activation: { type: "action", value: 1 },
                  range: { units: "self" },
                  attack: {
                    ability: "dex",
                    bonus: "",
                    flat: false,
                    type: { value: "melee", classification: "weapon" },
                  },
                },
              },
            },
          },
          {
            name: "Wind Javelin",
            type: "weapon",
            system: {
              description: {
                value:
                  "<p>[[/attack extended]]. <em>Hit:</em> [[/damage 1d6 + " +
                  "@abilities.dex.mod type=piercing average=true]] damage " +
                  "plus [[/damage 1d4 type=thunder average=true]] damage.</p>",
              },
              activities: {
                a1: {
                  type: "attack",
                  activation: { type: "action", value: 1 },
                  range: { value: 30, long: 120, units: "ft" },
                  attack: {
                    ability: "dex",
                    bonus: "",
                    flat: false,
                    type: { value: "melee", classification: "weapon" },
                  },
                },
              },
            },
          },
        ],
      },
      {
        _id: "m2",
        name: "Default AC Test",
        type: "npc",
        prototypeToken: {},
        system: {
          details: { cr: 1, type: { value: "beast" } },
          traits: { size: "med" },
          attributes: { ac: { flat: null, calc: "default" }, hp: { max: 10 } },
          abilities: { dex: { value: 14 } },
        },
      },
      {
        _id: "v1",
        name: "Airship",
        type: "vehicle",
        prototypeToken: {},
        system: { details: { type: { value: "air" } }, attributes: { hp: { max: 300 } } },
      },
      {
        _id: "i2",
        name: "Animated Shield",
        type: "equipment",
        img: "icons/svg/item-bag.svg",
        system: {
          rarity: "rare",
          attunement: "",
          type: { value: "shield" },
          weight: { value: 6, units: "lb" },
          description: { value: "<p>A shield.</p>" },
        },
      },
    ];

    const fixDir = mkdtempSync(join(tmpdir(), "gm-foundry-"));
    writeFileSync(join(fixDir, "in.json"), JSON.stringify(fixture));
    const conv = spawnSync(
      "node",
      ["scripts/import-foundry.mjs", join(fixDir, "in.json"), "cid", "-o", fixDir],
      { cwd: APP_ROOT, encoding: "utf8" }
    );
    if (conv.status !== 0) {
      throw new Error(`import-foundry.mjs failed:\n${conv.stderr}`);
    }

    const readRows = (f) =>
      readFileSync(join(fixDir, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));

    const outSpells = readRows("spells.jsonl");
    const outItems = readRows("items.jsonl");
    const outMonsters = readRows("monsters.jsonl");
    const monDefault = outMonsters.find((r) => r.name === "Default AC Test");
    const fb = outSpells.find((r) => r.name === "Fireball");
    const am = outSpells.find((r) => r.name === "Animal Messenger");
    const axe = outItems.find((r) => r.name === "Berserker Axe");
    const shield = outItems.find((r) => r.name === "Animated Shield");

    check("the converter splits spells from items", outSpells.length === 2 && outItems.length === 2);

    // A description is BLOCKS now, so the text has to be gathered back
    // out of them before it can be checked.
    const textOf = (r) =>
      (r.blocks ?? [])
        .map((b) =>
          b.type === "text"
            ? b.text
            : b.type === "list"
              ? b.items.join(" ")
              : [...b.headers, ...b.rows.flat()].join(" ")
        )
        .join("\n");

    const dirty = (r) => /@[A-Za-z]|\[\[|\w+=\S|&amp;|<[a-z]/i.test(textOf(r));
    check(
      "no Foundry markup survives into any description",
      ![...outSpells, ...outItems].some(dirty)
    );

    check("school abbreviations expand", fb.school === "Evocation");
    check("an Action is not written '1 Action'", fb.castingTime === "Action");
    check("'inst' reads as Instantaneous", fb.duration === "Instantaneous");
    check("components come from the properties array", fb.components === "V, S, M");
    check(
      "the 2024 target labels are rebuilt from system.target",
      textOf(fb).startsWith("Each creature in a 20-foot Sphere centered")
    );
    check(
      "a check enricher becomes a sentence",
      /an Intelligence \(Investigation\) check\b/.test(textOf(fb))
    );
    check(
      "the doubled noun after a check enricher is collapsed",
      !/check check/i.test(textOf(fb))
    );
    check(
      "a reference enricher keeps its word and drops its switches",
      /Blinded by it/.test(textOf(fb))
    );
    check(
      "a damage enricher keeps the dice",
      /8d6 fire damage/i.test(textOf(fb))
    );
    check(
      "a labelled UUID enricher keeps only its label",
      /Gameplay Toolbox/.test(textOf(fb))
    );
    // A BARE data path, outside any enricher — the 29-occurrence case.
    check(
      "a bare @attributes.spell.dc is translated into words",
      /against your spell save DC/.test(textOf(fb))
    );
    check(
      "a bare @item.level is translated into words",
      /using the spell's level slots/.test(textOf(fb))
    );

    check("ritual is read from properties", am.ritual === true);
    check("concentration is read from properties", am.concentration === true);
    check("a single mile is not '1 miles'", am.range === "1 mile");
    check("plural units pluralize", am.castingTime === "10 minutes");
    check(
      "a level-scaling duration says so instead of printing the formula",
      am.duration === "Varies (hours)"
    );

    // Proficiency bonus and XP are DERIVED from CR — Foundry computes
    // them when it prepares an actor, so source data has neither, and
    // reading them off the document leaves every monster blank.
    const mon = outMonsters.find((r) => r.name === "Ettin Test");
    check("proficiency is computed from CR", mon.proficiencyBonus === 3);
    check("XP is computed from CR", mon.xp === 3900);
    // Foundry nests sense distances under `.ranges`; reading them off
    // the senses object directly finds nothing.
    check("senses come from the nested ranges", mon.senses === "Darkvision 60 ft");
    check("habitat is joined and humanized", mon.habitat === "Forest, Underdark");
    // calc "natural" and "flat" store the number; "default" stores
    // nothing and means 10 + DEX.
    check("a natural AC is read straight", mon.ac === 15);
    check("a default AC is computed as 10 + DEX", monDefault.ac === 12);
    // A stat block's traits are FEATURES, not inventory: a chain shirt
    // is why the AC is 15, not a trait called "Chain Shirt".
    check(
      "armor is not a trait",
      !(mon.traits ?? []).some((t) => t.name === "Chain Shirt")
    );
    check(
      "a weapon is an action",
      (mon.actions ?? []).some((a) => a.name === "Morningstar")
    );
    check(
      "an always-on feature is a trait",
      (mon.traits ?? []).some((t) => t.name === "Two Heads")
    );
    // Legendary actions declare themselves by activation cost, not by a
    // feat subtype — Derek's export has no "legendary" subtype at all.
    check(
      "a legendary activation makes a legendary action",
      (mon.legendaryActions ?? []).some((a) => a.name === "Lash")
    );
    check("a vehicle is not a monster", !outMonsters.some((r) => r.name === "Airship"));

    // Artwork. The path has to be reachable, not merely faithful: what
    // Foundry calls "icons/..." the map server only serves from under
    // the mirror prefix, and storing Foundry's own path gave 7,361
    // images a URL that answers with the landing page.
    const { FOUNDRY_MIRROR } = await import(
      pathToFileURL(join(APP_ROOT, "scripts", "mirror.mjs")).href
    );
    check(
      "artwork is stored under the mirror the map server serves",
      fb.image === `${FOUNDRY_MIRROR}/icons/magic/fire/beam-jet-stream.webp`
    );
    check(
      "a placeholder icon is not artwork",
      shield.image === undefined
    );
    check(
      "an already-hosted image is left alone rather than mirrored",
      axe.image === undefined
    );

    // ---- a stat block's attacks, computed rather than read ---------
    const skirm = outMonsters.find((r) => r.name === "Aarakocra Skirmisher");
    const actionText = (name) =>
      (skirm?.actions ?? [])
        .find((a) => a.name === name)
        ?.blocks.map((b) => b.text)
        .join(" ") ?? "";

    // Checked against D&D Beyond's own rendering of this monster, which
    // is the only way to know the arithmetic is right rather than merely
    // plausible: dex 14 (+2) plus proficiency +2 from CR 1/4.
    check(
      "a melee attack line is composed from the activity and the actor",
      actionText("Talons").startsWith("Melee Attack Roll: +4, reach 5 ft.")
    );
    check(
      "damage carries its average, its formula and its type",
      /\b4 \(1d4 \+ 2\) Slashing damage/.test(actionText("Talons"))
    );
    check(
      "and again for the bigger die",
      /\b9 \(3d4 \+ 2\) Slashing damage/.test(actionText("Talons"))
    );
    check(
      "the switch word never reaches the page",
      !/extended/.test(actionText("Talons"))
    );
    check(
      "the enricher's full stop does not double the computed one",
      !/ft\.\./.test(actionText("Talons"))
    );
    check(
      "a thrown weapon reads as both, with both distances",
      actionText("Wind Javelin").startsWith(
        "Melee or Ranged Attack Roll: +4, reach 5 ft. or range 30/120 ft."
      )
    );
    check(
      "a second damage clause is computed too",
      /2 \(1d4\) Thunder damage/.test(actionText("Wind Javelin"))
    );
    // An item has no actor, so there is no bonus to state. Dropping it
    // is right; leaving "extended" behind is what used to happen.
    check(
      "no actor means no invented attack line",
      ![...outItems, ...outSpells].some((r) =>
        /Attack Roll:|extended/.test(textOf(r))
      )
    );

    check("rarity is humanized", axe.rarity === "Very Rare");
    check(
      "attunement is 'required', not a boolean field named attuned",
      axe.attunement === true && shield.attunement === false
    );
    check("price reads with its denomination", axe.price === "4000 gp");
    check("a weight of 0 means unset, not weightless", axe.weight === undefined);
    check("source is composed from the object", axe.source === "SRD 2024");
    check("a weapon is a weapon", axe.kind === "weapon");
    check("shield subtype folds into armor", shield.kind === "armor");

    return problems;
  },
};
