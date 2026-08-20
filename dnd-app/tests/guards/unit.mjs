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
import { APP_ROOT, read } from "./lib.mjs";

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

    // Every kind's subtitle must resolve on a nearly empty row — a
    // sparse import is the normal case, not the exception.
    for (const kind of ["spells", "items", "monsters"]) {
      let ok = true;
      try {
        look.lookupSubtitle(kind, { name: "x" });
      } catch {
        ok = false;
      }
      check(`lookupSubtitle.${kind} survives a nearly empty row`, ok);
    }
    check(
      "a cantrip's subtitle names it",
      look.lookupSubtitle("spells", { level: 0, school: "Evocation" }) ===
        "Cantrip · Evocation"
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
        system: {
          rarity: "veryRare",
          attunement: "required",
          attuned: false,
          price: { value: 4000, denomination: "gp" },
          weight: { value: 0, units: "lb" },
          type: { value: "martialM" },
          source: { rules: "2024" },
          description: { value: "<p>An axe.</p>" },
        },
      },
      {
        _id: "i2",
        name: "Animated Shield",
        type: "equipment",
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
    const fb = outSpells.find((r) => r.name === "Fireball");
    const am = outSpells.find((r) => r.name === "Animal Messenger");
    const axe = outItems.find((r) => r.name === "Berserker Axe");
    const shield = outItems.find((r) => r.name === "Animated Shield");

    check("the converter splits spells from items", outSpells.length === 2 && outItems.length === 2);

    // Nothing Foundry-shaped may survive into a description.
    const dirty = (r) => /@[A-Za-z]|\[\[|\w+=\S|&amp;|<[a-z]/i.test(r.description ?? "");
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
      fb.description.startsWith("Each creature in a 20-foot Sphere centered")
    );
    check(
      "a check enricher becomes a sentence",
      /an Intelligence \(Investigation\) check\b/.test(fb.description)
    );
    check(
      "the doubled noun after a check enricher is collapsed",
      !/check check/i.test(fb.description)
    );
    check(
      "a reference enricher keeps its word and drops its switches",
      /Blinded by it/.test(fb.description)
    );
    check(
      "a damage enricher keeps the dice",
      /8d6 fire damage/i.test(fb.description)
    );
    check(
      "a labelled UUID enricher keeps only its label",
      /Gameplay Toolbox/.test(fb.description)
    );
    // A BARE data path, outside any enricher — the 29-occurrence case.
    check(
      "a bare @attributes.spell.dc is translated into words",
      /against your spell save DC/.test(fb.description)
    );
    check(
      "a bare @item.level is translated into words",
      /using the spell's level slots/.test(fb.description)
    );

    check("ritual is read from properties", am.ritual === true);
    check("concentration is read from properties", am.concentration === true);
    check("a single mile is not '1 miles'", am.range === "1 mile");
    check("plural units pluralize", am.castingTime === "10 minutes");
    check(
      "a level-scaling duration says so instead of printing the formula",
      am.duration === "Varies (hours)"
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
