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
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT, appPath, read } from "./lib.mjs";

function compile(relPath) {
  const out = mkdtempSync(join(tmpdir(), "gm-unit-"));
  // A config rather than flags, because the modules under test import
  // each other by the app's "@/" alias and tsc takes `paths` only from
  // a tsconfig. Written into the temp dir with the app as its root, so
  // nothing here can pick up the app's own compilerOptions by accident.
  const config = join(out, "tsconfig.unit.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        outDir: out,
        module: "es2022",
        target: "es2022",
        // The DOM's types, so a browser-side module can be compiled for
        // its pure half. `screenGrab.ts` names `navigator` and `Blob`
        // in functions that never run here; without this the file will
        // not compile at all and its rectangle arithmetic — the part
        // most worth testing — goes untested.
        lib: ["es2022", "dom"],
        moduleResolution: "bundler",
        skipLibCheck: true,
        baseUrl: APP_ROOT,
        paths: { "@/*": ["./*"] },
        // Named explicitly because the config lives in a temp dir, and
        // tsc looks for @types beside the CONFIG rather than beside the
        // files. Without this, convex/auth.ts loses `process` and the
        // whole compile fails on a module that is not under test.
        typeRoots: [join(APP_ROOT, "node_modules", "@types")],
      },
      files: [join(APP_ROOT, relPath)],
    })
  );
  const r = spawnSync("npx", ["tsc", "-p", config], {
    cwd: APP_ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `could not compile ${relPath}:\n${(r.stdout ?? "") + (r.stderr ?? "")}`
    );
  }
  // The app is CommonJS by default, so mark the output as ESM.
  writeFileSync(join(out, "package.json"), '{"type":"module"}');

  // And give every relative import the extension Node's ESM loader
  // insists on. tsc emits `from "./noteFormat"` because a bundler
  // resolves that; Node does not, and the module under test only fails
  // once it imports a sibling — which is exactly when a module is
  // worth compiling with its imports rather than alone.
  for (const file of readdirSync(out)) {
    if (!file.endsWith(".js")) continue;
    const at = join(out, file);
    writeFileSync(
      at,
      readFileSync(at, "utf8").replace(
        /(from\s+")(\.\.?\/[^"]+?)(?<!\.js)(")/g,
        "$1$2.js$3"
      )
    );
  }
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
    // The tracker keys on this attribute and the canvas writes it, and
    // nothing between them is typed. The canvas is shared by the
    // notebook and by a session's two note sections now, so a rename
    // here would silence the format toolbar on three screens at once.
    check(
      "BOX_ATTR is the attribute the canvas actually sets",
      read("components", "BoxCanvas.tsx").includes(`${fmt.BOX_ATTR}=`)
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
    check("a GM sees all of them", st.visibleTabs(true).length === st.SETTINGS_TABS.length);
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
      "User is not GM-only — it is where everyone edits their name",
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
    check(
      "a GM keeps a GM tab",
      st.resolveTab("campaign", true) === "campaign"
    );
    check(
      "a player asking for a GM tab is redirected, not shown a blank page",
      st.resolveTab("campaign", false) === st.visibleTabs(false)[0].id
    );
    // Players was folded into Campaign. A saved selection pointing at
    // it has to land somewhere real rather than blanking the page —
    // same fallback the rename of General relied on.
    check(
      "the retired Players tab falls back rather than blanking the page",
      st.resolveTab("players", true) === st.SETTINGS_TABS[0].id &&
        !st.SETTINGS_TABS.some((t) => t.id === "players")
    );
    check(
      "losing the GM role moves you off a GM tab",
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
      "a player gets no GM-only section at all",
      !forPlayer.some((s) => s.id === "dm")
    );
    check(
      "a player's GM-only fields are not smuggled into More",
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
    // clock, the counter and the GM's Cancel are each checked on the
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

    // Revoked beats expired beats spent: a link the GM killed on Monday
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
    // A player writing a note is handing markup to the GM's browser.
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
    // The GM's own preference, and the reason it exists is the preview:
    // View as Player is meant to show what the table sees, so a prep
    // section still standing in it would make the preview a lie about
    // the only screen it is checked on.
    const sbDm = sb.setSectionDmOnly(sbBase, "tools", true);
    check(
      "a GM-only section renders for the GM",
      sb.visibleSidebar(sbDm, IDS, true).some((s) => s.id === "tools")
    );
    check(
      "and is gone when you are not the GM here",
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
      "marking a section GM-only does not hide its items for the GM",
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
    // The GM's own layout. Everything here is one property said five
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

    // ---- the classes list shows classes ----------------------------
    const CLASSES = [
      { _id: "1", name: "Fighter", isSubclass: false },
      { _id: "2", name: "Champion", isSubclass: true, parentClass: "Fighter" },
      { _id: "3", name: "Battle Master", isSubclass: true, parentClass: "Fighter" },
      { _id: "4", name: "Wizard", isSubclass: false },
      { _id: "5", name: "Abjurer", isSubclass: true, parentClass: "Wizard" },
      // A subclass whose parent is not in this library — a module that
      // ships subclasses alone produces exactly this.
      { _id: "6", name: "Bladesinger", isSubclass: true, parentClass: "Sorcerer" },
    ];
    const cr = look.classRows(CLASSES);

    check(
      "the list is classes, not classes and subclasses",
      cr.rows.filter((r) => r.isSubclass === true && r.parentClass === "Fighter")
        .length === 0
    );
    check(
      "a class carries its own subclasses",
      (cr.childrenOf.get("fighter") ?? []).map((r) => r.name).join() ===
        "Battle Master,Champion"
    );
    check(
      "and they are in name order regardless of input order",
      (cr.childrenOf.get("fighter") ?? [])[0].name === "Battle Master"
    );
    // The case that was reported as "classes are not grouping". A
    // library can hold the 2024 printing of every base class and the
    // 2014 printing of every subclass; run the 5e rule over it and the
    // classes are gone while the subclasses remain. Matching on the
    // parent ROW then finds nothing and the list is a flat pile.
    check(
      "a subclass whose class is absent is still grouped under it",
      (cr.childrenOf.get("sorcerer") ?? []).some(
        (r) => r.name === "Bladesinger"
      )
    );
    check(
      "and the group gets a heading row, marked as inferred",
      cr.rows.some((r) => r.name === "Sorcerer" && r.absent === true)
    );
    check(
      "an inferred heading is not mistaken for a subclass",
      cr.rows
        .filter((r) => r.absent === true)
        .every((r) => r.isSubclass !== true)
    );
    check(
      "its id is marked, so nothing tries to fetch a row that is not there",
      cr.rows
        .filter((r) => r.absent === true)
        .every((r) => String(r._id).startsWith(look.ABSENT_PARENT_ID))
    );
    check(
      "nothing real is lost overall",
      cr.rows.filter((r) => r.absent !== true).length +
        [...cr.childrenOf.values()].reduce((n, l) => n + l.length, 0) ===
        CLASSES.length
    );
    check(
      "and nothing real is counted twice",
      new Set([
        ...cr.rows.filter((r) => r.absent !== true).map((r) => r._id),
        ...[...cr.childrenOf.values()].flat().map((r) => r._id),
      ]).size === CLASSES.length
    );
    // A subclass that names no class at all cannot be grouped, so it
    // keeps its own row rather than vanishing into a blank heading.
    check(
      "a subclass naming no class keeps its own row",
      look
        .classRows([
          { _id: "z", name: "Mystery", isSubclass: true },
        ])
        .rows.some((r) => r.name === "Mystery")
    );

    check(
      "a parent named with different casing still matches",
      (look
        .classRows([
          { _id: "a", name: "Fighter", isSubclass: false },
          { _id: "b", name: "Champion", isSubclass: true, parentClass: "  fighter " },
        ])
        .childrenOf.get("fighter") ?? []).length === 1
    );
    check(
      "a library of only classes has no subclass map entries",
      look.classRows([{ _id: "x", name: "Bard", isSubclass: false }])
        .childrenOf.size === 0
    );

    // ---- species group by NAME, because nothing else says so -------
    // A subclass carries `parentClass`. A species carries nothing:
    // High Elf and Wood Elf are separate documents that only happen to
    // be named after the thing they vary. So the parent is read out of
    // the name — and the interesting half is everything it must NOT
    // group, because a name rule invents families very easily.
    const SPECIES = [
      { _id: "e", name: "Elf" },
      { _id: "e1", name: "High Elf" },
      { _id: "e2", name: "Wood Elf" },
      { _id: "e3", name: "Drow Elf" },
      { _id: "d", name: "Dwarf" },
      { _id: "d1", name: "Hill Dwarf" },
      { _id: "h", name: "Half-Elf" },
      { _id: "y", name: "Yuan-ti Pureblood" },
      { _id: "dr", name: "Dragonborn" },
    ];
    const sr = look.speciesRows(SPECIES);

    check(
      "a variant named after its base is filed under it",
      (sr.childrenOf.get("elf") ?? []).map((r) => r.name).join() ===
        "Elf,Drow Elf,High Elf,Wood Elf"
    );
    // THE BASE IS A VARIANT TOO, and the heading is nobody's entry.
    //
    // It used to be the base's own row, shown in full, with the others
    // hung underneath — so a Dragonborn showed the PHB write-up as if
    // it were the species rather than one printing of it. Every
    // printing sits under the heading now, the plain one first.
    check(
      "the family head is a heading, not one of the printings",
      sr.rows.some((r) => r.name === "Elf" && r.absent === true) &&
        !sr.rows.some((r) => r.name === "High Elf")
    );
    check(
      "and the plain printing leads its own variants",
      (sr.childrenOf.get("elf") ?? [])[0].name === "Elf"
    );
    // A family of one is not a family: a heading you must open to
    // reach the only thing under it is a click that buys nothing.
    check(
      "a species with no variants stays a plain row",
      sr.rows.some((r) => r.name === "Dragonborn" && r.absent !== true) &&
        !sr.childrenOf.has("dragonborn")
    );

    // Reported: three rows called Changeling showed as three separate
    // species. Nothing is named AFTER a Changeling, so the old rule
    // made each of them a family of its own — and all three then
    // looked up the same key for their count, which is how they came
    // to read "Changeling 1" three times over.
    check(
      "rows with the same name are one species, not three",
      (() => {
        const r = look.speciesRows([
          { _id: "1", name: "Changeling", source: "MPMM" },
          { _id: "2", name: "Changeling", source: "ERLW" },
          { _id: "3", name: "Changeling", source: "WBtW" },
        ]);
        return (
          r.rows.length === 1 &&
          r.rows[0].absent === true &&
          (r.childrenOf.get("changeling") ?? []).length === 3
        );
      })()
    );
    // The shape Derek described: Dragonborn with FOUR variants, the
    // plain printing among them rather than above them.
    check(
      "a base and its variants are one family of four",
      (() => {
        const r = look.speciesRows([
          { _id: "d", name: "Dragonborn", source: "PHB" },
          { _id: "c", name: "Chromatic Dragonborn", source: "FTD" },
          { _id: "g", name: "Gem Dragonborn", source: "FTD" },
          { _id: "m", name: "Metallic Dragonborn", source: "FTD" },
        ]);
        return (
          r.rows.length === 1 &&
          (r.childrenOf.get("dragonborn") ?? []).map((x) => x.name).join() ===
            "Dragonborn,Chromatic Dragonborn,Gem Dragonborn,Metallic Dragonborn"
        );
      })()
    );
    // The crash. Foundry disambiguates compendium entries by book, so
    // "Dhampir (VRGtR)" and "Hexblood (VRGtR)" end in the same
    // parenthetical — two rows share it, so it qualified as a base,
    // and the list grew a species called "(VRGtR)" whose synthetic id
    // went to Convex the moment it was opened.
    check(
      "a shared BOOK suffix is not a species",
      (() => {
        const r = look.speciesRows([
          { _id: "1", name: "Dhampir (VRGtR)", source: "VRGtR" },
          { _id: "2", name: "Hexblood (VRGtR)", source: "VRGtR" },
          { _id: "3", name: "Reborn (VRGtR)", source: "VRGtR" },
        ]);
        return r.rows.length === 3 && r.childrenOf.size === 0;
      })()
    );
    // The same with nothing to compare the suffix against, which is
    // where the source-matching half of splitSource cannot help.
    check(
      "and not even with no source field to match it against",
      (() => {
        const r = look.speciesRows([
          { _id: "1", name: "Dhampir (VRGtR)" },
          { _id: "2", name: "Hexblood (VRGtR)" },
        ]);
        return r.rows.length === 2 && r.childrenOf.size === 0;
      })()
    );
    check(
      "no inferred parent is ever named only a parenthetical",
      look
        .speciesRows([
          { _id: "1", name: "Dhampir (VRGtR)", source: "VRGtR" },
          { _id: "2", name: "Hexblood (VRGtR)", source: "VRGtR" },
        ])
        .rows.every((r) => !/^\(.*\)$/.test(String(r.name)))
    );
    // A parenthetical splitSource DECLINES to strip. "Homebrew" is not
    // a book abbreviation — one capital, a real word — so it stays on
    // the name, and without a rule refusing a wholly-parenthesised
    // base it would become one the moment two rows shared it.
    check(
      "a parenthetical that is not a book is still never a base",
      (() => {
        const r = look.speciesRows([
          { _id: "1", name: "Dhampir (Homebrew)" },
          { _id: "2", name: "Hexblood (Homebrew)" },
        ]);
        return r.rows.length === 2 && r.childrenOf.size === 0;
      })()
    );

    // Grouping reads the CLEANED name. With book suffixes on both the
    // base and the variant, matching on raw names finds nothing —
    // "High Elf (PHB)" does not end in "Elf (PHB)" the way it ends in
    // "Elf" — and the family silently stops grouping.
    check(
      "a family whose rows all carry a book suffix still groups",
      (() => {
        const r = look.speciesRows([
          { _id: "e", name: "Elf (PHB)", source: "PHB" },
          { _id: "1", name: "High Elf (PHB)", source: "PHB" },
          { _id: "2", name: "Wood Elf (PHB)", source: "PHB" },
        ]);
        return (
          r.rows.length === 1 && (r.childrenOf.get("elf") ?? []).length === 3
        );
      })()
    );

    // With ONE variant the shared-suffix rule cannot help — two rows
    // have to share a name for that — so this is the case that proves
    // the base is recognised by its own cleaned name.
    check(
      "a lone variant groups under a base that carries a book suffix",
      (() => {
        const r = look.speciesRows([
          { _id: "e", name: "Elf (PHB)", source: "PHB" },
          { _id: "1", name: "High Elf (PHB)", source: "PHB" },
        ]);
        return (
          r.rows.length === 1 && (r.childrenOf.get("elf") ?? []).length === 2
        );
      })()
    );

    // And the form that DOES group must survive the fix.
    check(
      "a qualified variant still groups under its base",
      (look
        .speciesRows([
          { _id: "g", name: "Genasi", source: "MPMM" },
          { _id: "1", name: "Genasi (Air)", source: "MPMM" },
          { _id: "2", name: "Genasi (Fire)", source: "MPMM" },
        ])
        .childrenOf.get("genasi") ?? []).length === 3
    );

    // The two that make a suffix rule dangerous.
    check(
      "Half-Elf is its own species, not an Elf variant",
      sr.rows.some((r) => r.name === "Half-Elf") &&
        !(sr.childrenOf.get("elf") ?? []).some((r) => r.name === "Half-Elf")
    );
    check(
      "a name whose last word is not a species invents no family",
      sr.rows.some((r) => r.name === "Yuan-ti Pureblood") &&
        !sr.childrenOf.has("pureblood")
    );
    check(
      "nothing is lost",
      sr.rows.filter((r) => r.absent !== true).length +
        [...sr.childrenOf.values()].reduce((n, l) => n + l.length, 0) ===
        SPECIES.length
    );
    // And nothing is DOUBLED either, which the old shape could do: a
    // row that headed a family and was also filed under a grandparent
    // appeared in two places, and both counts were then right about
    // different things.
    check(
      "and nothing appears twice",
      (() => {
        const seen = new Set();
        for (const r of sr.rows) if (r.absent !== true) seen.add(r._id);
        for (const l of sr.childrenOf.values()) for (const r of l) {
          if (seen.has(r._id)) return false;
          seen.add(r._id);
        }
        return seen.size === SPECIES.length;
      })()
    );

    // ---- what a variant is called under its family -----------------
    // A printing named after its family would otherwise repeat the
    // heading it sits beneath, in a list whose whole job is telling the
    // printings apart. Its BOOK is what distinguishes it.
    check(
      "a variant named after its family wears its book",
      look.variantLabel("Dragonborn", {
        name: "Dragonborn",
        source: "PHB",
      }) === "Player's Handbook version"
    );
    check(
      "with nothing to wear when there is no book",
      look.variantLabel("Dragonborn", { name: "Dragonborn" }) ===
        "Base version"
    );
    check(
      "and a variant with its own name keeps it",
      look.variantLabel("Dragonborn", {
        name: "Chromatic Dragonborn",
        source: "FTD",
      }) === "Chromatic Dragonborn"
    );
    // The book suffix comes off first, or "Dragonborn (PHB)" would look
    // like a differently-named variant and keep the repeated heading.
    check(
      "a book suffix on the name does not make it a different variant",
      look.variantLabel("Dragonborn", {
        name: "Dragonborn (PHB)",
        source: "PHB",
      }) === "Player's Handbook version"
    );
    check(
      "and matching ignores case and spacing",
      look.variantLabel("  dragonborn ", {
        name: "Dragonborn",
        source: "PHB",
      }) === "Player's Handbook version"
    );
    // The other naming form exports use.
    check(
      "the qualified form groups too",
      (look
        .speciesRows([
          { _id: "g", name: "Genasi" },
          { _id: "g1", name: "Genasi (Air)" },
          { _id: "g2", name: "Genasi (Fire)" },
        ])
        .childrenOf.get("genasi") ?? []).length === 3
    );
    // The MOST SPECIFIC base wins, and a real species stays a parent.
    // Both rows here end in "Yanki", so two rows share that word and it
    // qualifies as an inferred base — taking the first candidate filed
    // the real Gith Yanki under an invented Yanki.
    check(
      "the longest base wins, not the first one that qualifies",
      (() => {
        const r = look.speciesRows([
          { _id: "a", name: "Gith Yanki" },
          { _id: "b", name: "Duthka Gith Yanki" },
        ]);
        return (
          (r.childrenOf.get("gith yanki") ?? []).length === 2 &&
          !r.childrenOf.has("yanki")
        );
      })()
    );
    check(
      "a species others are named after heads its own family",
      (() => {
        const r = look.speciesRows([
          { _id: "a", name: "Gith Yanki" },
          { _id: "b", name: "Duthka Gith Yanki" },
        ]);
        return r.rows.length === 1 && r.rows[0].name === "Gith Yanki";
      })()
    );
    check(
      "and a more specific REAL base beats a shorter real one",
      (() => {
        const r = look.speciesRows([
          { _id: "e", name: "Elf" },
          { _id: "w", name: "Wood Elf" },
          { _id: "g", name: "Grey Wood Elf" },
          { _id: "h", name: "High Elf" },
        ]);
        return (r.childrenOf.get("wood elf") ?? []).some(
          (x) => x.name === "Grey Wood Elf"
        );
      })()
    );
    // Reached through the dispatch the screen actually calls, so
    // dropping species from it cannot pass unnoticed.
    check(
      "familyRows routes species to the species grouping",
      (look.familyRows("species", [
        { _id: "e", name: "Elf" },
        { _id: "w", name: "Wood Elf" },
      ])?.childrenOf.get("elf") ?? []).length === 2
    );
    check(
      "familyRows routes classes to the class grouping",
      (look.familyRows("classes", [
        { _id: "f", name: "Fighter", isSubclass: false },
        { _id: "c", name: "Champion", isSubclass: true, parentClass: "Fighter" },
      ])?.childrenOf.get("fighter") ?? []).length === 1
    );
    check(
      "and leaves the flat kinds alone",
      ["spells", "items", "monsters", "feats", "backgrounds"].every(
        (k) => look.familyRows(k, [{ _id: "x", name: "Thing" }]) === null
      )
    );
    // A variant whose base is not in the library still groups, same as
    // a subclass whose class the edition rule dropped — and for the
    // same reason: in a 5e campaign the edition rule drops the 2024
    // "Elf" and keeps the 2014 High Elf and Wood Elf.
    check(
      "two variants of an absent base group under an inferred heading",
      (() => {
        const r = look.speciesRows([
          { _id: "x", name: "High Elf" },
          { _id: "y", name: "Wood Elf" },
        ]);
        return (
          r.rows.length === 1 &&
          r.rows[0].name === "Elf" &&
          r.rows[0].absent === true &&
          (r.childrenOf.get("elf") ?? []).length === 2
        );
      })()
    );
    // ONE is not a family. This is the whole safety property of
    // inferring a base from names.
    check(
      "a single name ending in a word invents nothing",
      (() => {
        const r = look.speciesRows([
          { _id: "x", name: "Yuan-ti Pureblood" },
        ]);
        return r.rows.length === 1 && r.childrenOf.size === 0;
      })()
    );

    // ---- a source hiding in the name -------------------------------
    // Foundry disambiguates compendium entries by suffix, which reads
    // fine in a compendium browser and badly beside a Source column
    // where the same four letters then appear twice on every row.
    check(
      "a parenthetical that IS the source comes off the name",
      look.splitSource("Arcane Archer (XGtE)", "XGtE").name === "Arcane Archer"
    );
    check(
      "and the source survives it",
      look.splitSource("Arcane Archer (XGtE)", "XGtE").source === "XGtE"
    );
    check(
      "a parenthetical with no source becomes one",
      (() => {
        const r = look.splitSource("Agent of the Ninth Quill (DMLS)", "");
        return r.name === "Agent of the Ninth Quill" && r.source === "DMLS";
      })()
    );
    // The half that stops this truncating names. A parenthetical that
    // is not a book is part of what the thing is called.
    check(
      "a parenthetical that is not a book is left alone",
      look.splitSource("Bag of Holding (Greater)", "").name ===
        "Bag of Holding (Greater)"
    );
    check(
      "a parenthetical that DISAGREES with the source is left alone",
      look.splitSource("Foo (XGtE)", "PHB").name === "Foo (XGtE)"
    );
    check(
      "a name with no parenthetical is untouched",
      look.splitSource("Acolyte - Baldur's Gate", "BGDiA").name ===
        "Acolyte - Baldur's Gate"
    );
    check(
      "a name that is ONLY a parenthetical is not emptied",
      look.splitSource("(XGtE)", "").name === "(XGtE)"
    );
    check(
      "a missing name does not throw",
      look.splitSource(undefined, undefined).name === "" &&
        look.splitSource(undefined, undefined).source === null
    );
    // The Name column sorts on the CLEAN name, or the suffix decides
    // where a row files.
    check(
      "the name column shows and sorts the clean name",
      (() => {
        const col = look.LOOKUP_COLUMNS.classes.find((c) => c.key === "name");
        const row = { name: "Arcane Archer (XGtE)", source: "XGtE" };
        return col.get(row) === "Arcane Archer" &&
          col.sort(row) === "arcane archer";
      })()
    );
    check(
      "every kind has a Source column",
      Object.keys(look.LOOKUP_TITLES).every((k) =>
        look.LOOKUP_COLUMNS[k].some((c) => c.key === "source")
      )
    );
    // The fixture is real — "Agent of the Ninth Quill (DMLS)" is a row
    // in the library with an empty source field and the book in its
    // name. It used to expect "DMLS" back, because DMLS was a code the
    // map had never heard of; it has one now, so the expectation is the
    // book. The thing being proved is unchanged: the column reads the
    // source OUT OF THE NAME rather than off the empty field, and an
    // implementation that read the field would return "" either way.
    check(
      "the Source column reads the extracted source, not the raw field",
      look.LOOKUP_COLUMNS.classes
        .find((c) => c.key === "source")
        .get({ name: "Agent of the Ninth Quill (DMLS)", source: "" }) ===
        "Dungeon Masters: Living Spells"
    );

    // ---- feats, backgrounds, classes and species -------------------
    // The four build kinds share one renderer, so the thing worth
    // checking is that they do NOT all say the same thing: the whole
    // point of one subtitle function over four is that the answer
    // still depends on the kind AND on the row.
    check(
      "a feat's subtitle names its category",
      look.buildSubtitle("feats", { category: "Origin" }) === "Origin Feat"
    );
    check(
      "and a feat with no category is still a feat",
      look.buildSubtitle("feats", {}) === "Feat"
    );
    check(
      "a subclass says whose it is",
      look.buildSubtitle("classes", {
        isSubclass: true,
        parentClass: "Fighter",
      }) === "Fighter Subclass"
    );
    check(
      "a subclass with no parent does not say 'undefined Subclass'",
      look.buildSubtitle("classes", { isSubclass: true }) === "Subclass"
    );
    check(
      "a class says how far its casting goes",
      look.buildSubtitle("classes", {
        isSubclass: false,
        spellcasting: "Full",
      }) === "Class · Full Caster"
    );
    check(
      "a non-caster class does not claim a progression",
      look.buildSubtitle("classes", { isSubclass: false }) === "Class"
    );
    check(
      "a species reads size then type",
      look.buildSubtitle("species", {
        size: "Small",
        creatureType: "Humanoid",
      }) === "Small Humanoid"
    );
    // Half a phrase is the failure worth having a test for: "Small
    // undefined" or a leading space both look like a bug in the data.
    check(
      "a species missing its type keeps the half it has, cleanly",
      look.buildSubtitle("species", { size: "Small" }) === "Small"
    );
    check(
      "a species missing its size keeps the other half, cleanly",
      look.buildSubtitle("species", { creatureType: "Humanoid" }) ===
        "Humanoid"
    );
    check(
      "a species with neither still says what it is",
      look.buildSubtitle("species", {}) === "Species"
    );
    check(
      "a background needs no embellishment",
      look.buildSubtitle("backgrounds", { skills: "Stealth" }) === "Background"
    );

    // Facts: absent fields are SKIPPED, never printed empty. A Foundry
    // export is as likely to omit a field as to get it wrong, and a
    // column of dashes reads as data loss.
    const featFacts = look.buildFacts("feats", {
      prerequisite: "Level 4",
      repeatable: true,
    });
    check(
      "buildFacts lists what is there",
      featFacts.length === 2 &&
        featFacts[0].label === "Prerequisite" &&
        featFacts[0].value === "Level 4"
    );
    check(
      "and nothing at all when there is nothing",
      look.buildFacts("feats", {}).length === 0
    );
    check(
      "a false repeatable is not a fact worth printing",
      look.buildFacts("feats", { repeatable: false }).length === 0
    );
    check(
      "every fact has a non-empty value",
      look
        .buildFacts("backgrounds", {
          abilities: "Int, Wis, Cha",
          skills: "Insight, Religion",
          tools: "",
          feat: null,
        })
        .every((f) => f.value && f.value.length > 0)
    );
    check(
      "an empty string is not a fact",
      look.buildFacts("backgrounds", { abilities: "", skills: "  " })
        .length === 0
    );
    check(
      "zero darkvision is not darkvision",
      look
        .buildFacts("species", { darkvision: 0 })
        .every((f) => f.label !== "Darkvision")
    );
    check(
      "and a real one is written in feet",
      look
        .buildFacts("species", { darkvision: 60 })
        .some((f) => f.label === "Darkvision" && f.value === "60 ft")
    );
    // Only a subclass repeats its class in the facts — on a class the
    // subtitle already said it.
    check(
      "a class does not list itself under Class",
      look
        // WITH a name: the mistake worth catching is falling back to
        // it, and a row with no name cannot show that happening.
        .buildFacts("classes", {
          isSubclass: false,
          name: "Fighter",
          hitDie: "d10",
        })
        .every((f) => f.label !== "Class")
    );
    check(
      "a subclass does",
      look
        .buildFacts("classes", { isSubclass: true, parentClass: "Fighter" })
        .some((f) => f.label === "Class" && f.value === "Fighter")
    );

    // Sorting a column most rows leave blank must not bury the answer.
    // Ascending by Prerequisite means "show me the ones that have
    // one" — and with the blanks sorting first you get two hundred
    // empty rows above the fifteen you clicked for.
    check(
      "a blank prerequisite sorts LAST, not first",
      look
        .sortByColumn(
          "feats",
          [
            { name: "Alert" },
            { name: "Grappler", prerequisite: "Level 4" },
            { name: "Tough" },
          ],
          "prerequisite",
          false
        )
        .map((r) => r.name)
        .join() === "Grappler,Alert,Tough"
    );
    // There is no Class column. It answered "which class is this" for
    // a flat list; the tab groups structurally now, so on a subclass it
    // repeated the heading you opened to get there and on a class it
    // repeated the name in the cell beside it. The two checks above
    // are what still has to hold: the parent survives as a FACT on the
    // opened subclass, which is the one place it is not already on
    // screen.
    check(
      "the classes tab has no column repeating the name or the heading",
      look.LOOKUP_COLUMNS.classes.every((c) => c.key !== "parentClass")
    );

    // The same shape one column over, so the rule is the property of
    // the file rather than of one comparator.
    check(
      "and so does a blank spellcasting progression",
      look
        .sortByColumn(
          "classes",
          [
            { name: "Fighter", isSubclass: false },
            { name: "Wizard", isSubclass: false, spellcasting: "Full" },
          ],
          "spellcasting",
          false
        )
        .map((r) => r.name)
        .join() === "Wizard,Fighter"
    );

    // Every kind must have columns, and every column must be readable.
    for (const kind of Object.keys(look.LOOKUP_TITLES)) {
      const cols = look.LOOKUP_COLUMNS[kind];
      check(
        `${kind} has columns, and one of them is the name`,
        Array.isArray(cols) &&
          cols.length > 0 &&
          cols.some((c) => c.primary === true)
      );
      check(
        `${kind}'s columns survive a row with nothing in it`,
        cols.every((c) => {
          const v = c.get({});
          return v === null || typeof v === "string";
        })
      );
      // sort() too, not just get(). A column whose comparator throws
      // on an empty field takes the whole table down the moment
      // someone clicks its heading — and the row that triggers it is
      // the one nobody filled in.
      check(
        `${kind}'s comparators survive a row with nothing in it`,
        cols.every((c) => {
          if (!c.sort) return true;
          const v = c.sort({});
          return typeof v === "number" || typeof v === "string";
        })
      );
      check(
        `${kind}'s column keys are unique`,
        new Set(cols.map((c) => c.key)).size === cols.length
      );
    }

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
      // so the filler at the end has to stretch — otherwise the columns
      // bunch at the left of the table with dead space beside them.
      check(
        `${kind} gives the slack to the filler once nothing else flexes`,
        look.columnTemplate(kind, pinned).endsWith(" minmax(0, 1fr)")
      );
      // No column flexes by default any more: the Name column's `2fr`
      // became a measured width, because grow-to-fill put half a wide
      // screen between a spell's name and its level. So the filler
      // stretches from the start — and the flat-filler rule still holds
      // where a template actually has an fr track.
      check(
        `${kind} hands the slack to the filler by default`,
        look.columnTemplate(kind).endsWith(" minmax(0, 1fr)")
      );
      check(
        `${kind} has no grow-to-fill column for the filler to fight`,
        !look.columnTemplate(kind).includes("fr)) ") &&
          !look
            .columnTemplate(kind)
            .split(" ")
            .some((t) => /^\d+fr$/.test(t))
      );
      // The button LEADS the row — the whole point of moving it off the
      // right-hand edge — and its track is fixed, so it does not grow
      // with the table and strand the name halfway across it.
      check(
        `${kind} opens from the head of the row`,
        look.columnTemplate(kind).startsWith(`${look.EXPAND_TRACK} `) &&
          look.columnTemplate(kind, pinned).startsWith(`${look.EXPAND_TRACK} `)
      );
    }

    // A resized column is a pixel track; an untouched one keeps what it
    // was declared with, so an account that has never dragged anything
    // sees the designed table.
    const withWidth = look.columnTemplate("items", { rarity: 200 });
    check("a resized column becomes a pixel track", withWidth.includes("200px"));
    check(
      "an untouched column keeps its declared track",
      withWidth.includes("11rem")
    );
    check(
      "a width below the minimum is clamped, not obeyed",
      look
        .columnTemplate("items", { rarity: 4 })
        .includes(`${look.MIN_LOOKUP_COL}px`)
    );

    // ---- the Name column, sized by what is in it -------------------
    // It grew to fill, which on a wide screen put half the viewport
    // between a spell's name and its level. The default is now "a
    // little bigger than the longest name in that list" — Derek's
    // words — with a floor and a ceiling, and a dragged width still
    // wins over all of it.
    {
      const px = (names) => look.nameTrackPx(names);

      check(
        "a longer longest name gets a wider column",
        px(["Abi-Dalzim's Horrid Wilting", "Aid"]) > px(["Aid", "Alarm"])
      );
      check(
        "the longest name drives it, wherever it sits in the list",
        px(["Aid", "Abi-Dalzim's Horrid Wilting"]) ===
          px(["Abi-Dalzim's Horrid Wilting", "Aid"])
      );
      // "A little bigger" — but bigger than what? The primary cell is
      // not just text: a 2rem artwork thumbnail and the variant count
      // pill sit inside the same track. Demanding text-plus-a-whisker
      // let a mutation zero the allowance for both and pass — every
      // name would have ellipsised behind its own picture.
      check(
        "the column allows for the artwork and count beside the name",
        px(["Abi-Dalzim's Horrid Wilting"]) >=
          Math.round("Abi-Dalzim's Horrid Wilting".length * 7.7) + 32 + 18
      );
      check(
        "an empty list still yields a usable column",
        px([]) >= 176
      );
      check(
        "short names do not shrink the column below its floor",
        px(["Aid"]) === px([])
      );
      // One 70-character name in an import must not push every other
      // column off screen for the whole table; past the cap the one
      // long row ellipsises like any other long cell.
      check(
        "a pathological name hits the ceiling instead of taking the screen",
        px(["x".repeat(70)]) === px(["x".repeat(200)]) &&
          px(["x".repeat(200)]) <= 480
      );
      // The default is a default: a dragged width spreads OVER it in
      // the template call, so the person's choice survives.
      check(
        "a dragged name width still beats the measured default",
        look
          .columnTemplate("spells", { name: 999 })
          .includes("999px")
      );
    }
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
    // "items" throughout: these are the REFERENCE kinds, where a
    // 2024-only entry is a thing you can still use in a 5e game.
    const names = (ed) =>
      filt.applyEdition(library, ed, "items").map((r) => `${r.name}/${r.source}`);

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
      new Set(filt.applyEdition(library, "2014", "items").map((r) => r.name))
        .size === new Set(library.map((r) => r.name)).size &&
        new Set(filt.applyEdition(library, "2024", "items").map((r) => r.name))
          .size === new Set(library.map((r) => r.name)).size
    );

    // The whole point, end to end: the 5e edition rule and the
    // grouping together must still produce a list of CLASSES.
    check(
      "a 5e library of 2024 classes and 2014 subclasses still groups",
      (() => {
        const lib = filt.applyEdition(
          [
            { _id: "1", name: "Fighter", isSubclass: false, source: "PHB 2024" },
            { _id: "2", name: "Arcane Archer", isSubclass: true, parentClass: "Fighter", source: "XGtE" },
            { _id: "3", name: "Banneret", isSubclass: true, parentClass: "Fighter", source: "FRHoF" },
          ],
          "2014",
          "classes"
        );
        const g = look.classRows(lib);
        return (
          g.rows.length === 1 &&
          g.rows[0].name === "Fighter" &&
          (g.childrenOf.get("fighter") ?? []).length === 2
        );
      })()
    );

    // ---- the same entry, imported twice ----------------------------
    // A Foundry world with one compendium loaded from two modules
    // produces this by the dozen. The edition rule cannot help: both
    // copies match the wanted edition, so both survive it.
    const twice = [
      { name: "Artisan", source: "PHB 2024" },
      { name: "Artisan", source: "PHB 2024" },
      { name: "Archaeologist", source: "ToA" },
      { name: "Archaeologist", source: "EFotA" },
    ];
    check(
      "the same name from the same book collapses to one",
      filt.dedupeExact(twice).filter((r) => r.name === "Artisan").length === 1
    );
    check(
      "the same name from DIFFERENT books does not",
      filt.dedupeExact(twice).filter((r) => r.name === "Archaeologist")
        .length === 2
    );
    check(
      "the first copy is the one kept",
      filt.dedupeExact([
        { name: "Artisan", source: "PHB 2024", keep: true },
        { name: "Artisan", source: "PHB 2024", keep: false },
      ])[0].keep === true
    );
    check(
      "casing and spacing do not make two entries out of one",
      filt.dedupeExact([
        { name: "Artisan", source: "PHB 2024" },
        { name: "  artisan ", source: "phb  2024" },
      ]).length === 1
    );
    // And it runs inside applyEdition, so no screen can forget it.
    check(
      "applyEdition collapses exact duplicates without being asked",
      filt.applyEdition(
        [
          { name: "Artisan", source: "PHB 2024" },
          { name: "Artisan", source: "PHB 2024" },
        ],
        "2024",
        "backgrounds"
      ).length === 1
    );

    // ---- and the build kinds, where 2024 is EXCLUSIVE --------------
    // A character-build option belongs to an edition the way a stat
    // block does not: the 2024 Goliath is built on 2024's species
    // rules, and a 5e table has nowhere to put it. So the fallback
    // that keeps a 2024-only monster is exactly wrong here.
    const speciesLib = [
      { name: "Aasimar", source: "MotM" },
      { name: "Aasimar", source: "PHB 2024" },
      { name: "Goliath", source: "PHB 2024" },
      { name: "Warforged", source: "ERLW" },
    ];
    const spec = (ed) =>
      filt
        .applyEdition(speciesLib, ed, "species")
        .map((r) => `${r.name}/${r.source}`);

    check(
      "5e drops a 2024 species even when nothing shares its name",
      !spec("2014").includes("Goliath/PHB 2024")
    );
    check(
      "and keeps the older printing of one that has both",
      spec("2014").includes("Aasimar/MotM") &&
        !spec("2014").includes("Aasimar/PHB 2024")
    );
    check(
      "5.5e keeps the 2024 printing and drops its older twin",
      spec("2024").includes("Aasimar/PHB 2024") &&
        !spec("2024").includes("Aasimar/MotM")
    );
    // The asymmetry, stated as a test because it looks like an
    // oversight otherwise: only the NEWER direction is exclusive.
    check(
      "a 2014-only species still shows in a 5.5e campaign",
      spec("2024").includes("Warforged/ERLW")
    );

      // ---- the buttons that let you see both ---------------------
      // The rule above is now where the BUTTONS start rather than what
      // the campaign is stuck with. Which means the single-edition
      // behaviour has to be exactly what it was, or every campaign
      // that never touches the buttons has quietly changed.
      check(
        "one edition on is the rule the campaign had before",
        JSON.stringify(
          filt.applyEditions(speciesLib, { "2014": true, "2024": false }, "species")
        ) ===
          JSON.stringify(filt.applyEdition(speciesLib, "2014", "species")) &&
          JSON.stringify(
            filt.applyEditions(speciesLib, { "2014": false, "2024": true }, "species")
          ) === JSON.stringify(filt.applyEdition(speciesLib, "2024", "species"))
      );
      check(
        "a 5e campaign starts on 5e and not the other one",
        JSON.stringify(filt.defaultEditions("2014")) ===
          JSON.stringify({ "2014": true, "2024": false })
      );
      check(
        "and a 5.5e campaign the other way round",
        JSON.stringify(filt.defaultEditions("2024")) ===
          JSON.stringify({ "2014": false, "2024": true })
      );

      // Both on shows BOTH printings. Not a merge — collapsing Aasimar
      // to one row would be the app still choosing, which is the thing
      // the buttons exist to stop.
      {
        const both = filt
          .applyEditions(speciesLib, { "2014": true, "2024": true }, "species")
          .map((r) => `${r.name}/${r.source}`);
        check(
          "both on keeps both printings of a species",
          both.includes("Aasimar/MotM") && both.includes("Aasimar/PHB 2024")
        );
        check(
          "both on keeps a 2024-only build option a 5e table would drop",
          both.includes("Goliath/PHB 2024")
        );
        check("both on keeps everything", both.length === speciesLib.length);
      }

      // Still deduped with both on: one entry imported from two
      // modules is one entry however many editions are showing.
      check(
        "both on still collapses the same row imported twice",
        filt.applyEditions(
          [
            { name: "Aasimar", source: "MotM" },
            { name: "Aasimar", source: "MotM" },
          ],
          { "2014": true, "2024": true },
          "species"
        ).length === 1
      );

      check(
        "neither on shows nothing, rather than everything",
        filt.applyEditions(speciesLib, { "2014": false, "2024": false }, "species")
          .length === 0
      );
    check(
      "every build kind gets the same rule, not just species",
      ["feats", "backgrounds", "classes"].every(
        (k) =>
          !filt
            .applyEdition(
              [{ name: "Grappler", source: "PHB 2024" }],
              "2014",
              k
            )
            .length
      )
    );
    // And the reference kinds are UNCHANGED, which is the other half
    // of the report: a 2024-only monster is still a monster.
    check(
      "a reference kind still keeps a 2024-only entry in a 5e campaign",
      ["spells", "items", "monsters"].every(
        (k) =>
          filt.applyEdition(
            [{ name: "Goliath", source: "PHB 2024" }],
            "2014",
            k
          ).length === 1
      )
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

    // ---- what every record list does to a row ----------------------
    // These moved out of NpcTable so the Groups screen could use them
    // rather than reimplement them faithfully enough. Which makes them
    // worth testing on their own: a regression here is now two screens
    // full of blanks rather than one.
    {
      const grid = await import(
        pathToFileURL(
          join(compile("components/recordGrid.ts"), "recordGrid.js")
        ).href
      );

      check(
        "a row with nothing in the field lands in the empty bucket",
        grid.facetValues({ groups: [] }, "groups").join() === grid.EMPTY &&
          grid.facetValues({}, "name").join() === grid.EMPTY
      );
      check(
        "a blank string in an array is not a value",
        grid.facetValues({ g: ["Guild", "  ", ""] }, "g").join() === "Guild"
      );
      // The distinction the chips cell turns on: the placeholder is for
      // FACETING, and drawing it as a pill would put an em dash in the
      // cell that reads like a value somebody typed.
      check(
        "chips drop the placeholder the facets keep",
        grid.chipValues({ g: [] }, "g").length === 0
      );

      check(
        "a boolean displays as a word, not as true",
        grid.display({ hidden: false }, "hidden") === "No"
      );
      check(
        "an array displays as a list",
        grid.display({ g: ["A", "B"] }, "g") === "A, B"
      );
      check(
        "a zero is not mistaken for empty",
        grid.display({ n: 0 }, "n") === "0"
      );

      // Blanks last in BOTH directions. Sorting a mostly-empty column
      // means "show me the ones that have something", and clicking the
      // heading again asks for the other end of that answer — not for
      // the two hundred rows that had no answer at all. Negating the
      // comparator reverses the blanks with everything else, which is
      // what both grids used to do, so this is asserted through
      // sortRows rather than through compare.
      const rows = [{ n: "b" }, {}, { n: "a" }];
      check(
        "blanks sort last ascending",
        grid.sortRows(rows, "n", true).map((r) => r.n ?? "-").join() === "a,b,-"
      );
      check(
        "and still last descending",
        grid.sortRows(rows, "n", false).map((r) => r.n ?? "-").join() === "b,a,-"
      );
      check(
        "sorting does not reorder the array it was handed",
        rows[0].n === "b" && rows[1].n === undefined
      );
      // A value the named order has never heard of is as blank as no
      // value, so it sinks either way rather than bobbing to the top on
      // the way back.
      const ages = [{ m: "Adult" }, { m: "Wyrmling" }, { m: "Child" }];
      const RANK = { m: ["Child", "Adult", "Senior"] };
      check(
        "an unrecognised rank sorts last ascending",
        grid.sortRows(ages, "m", true, RANK).map((r) => r.m).join() ===
          "Child,Adult,Wyrmling"
      );
      check(
        "and last descending too",
        grid.sortRows(ages, "m", false, RANK).map((r) => r.m).join() ===
          "Adult,Child,Wyrmling"
      );
      check(
        "an empty array counts as blank, not as a value",
        grid.compare({ g: [] }, { g: ["x"] }, "g") === 1
      );
      check(
        "numbers compare as numbers",
        grid.compare({ n: 9 }, { n: 100 }, "n") < 0
      );
      check(
        "a named order beats the alphabet",
        grid.compare({ m: "Child" }, { m: "Adult" }, "m", {
          m: ["Child", "Adult", "Senior"],
        }) < 0
      );
      check(
        "a value the named order has never heard of sorts last",
        grid.compare({ m: "Wyrmling" }, { m: "Senior" }, "m", {
          m: ["Child", "Adult", "Senior"],
        }) > 0
      );

      // A row in two groups is in both. Showing it once under whichever
      // came first would make one of the two counts wrong.
      const grouped = grid.groupRows(
        [
          { name: "Kelja", g: ["Guild", "Council"] },
          { name: "Orin", g: ["Guild"] },
          { name: "Sten", g: [] },
        ],
        "g"
      );
      check(
        "a row in two groups appears under both",
        grouped.find(([v]) => v === "Guild")[1].length === 2 &&
          grouped.find(([v]) => v === "Council")[1].length === 1
      );
      check(
        "the no-value bucket sorts last, whatever its size",
        grouped[grouped.length - 1][0] === grid.EMPTY
      );
      check(
        "the biggest group leads",
        grouped[0][0] === "Guild"
      );

      // An option you have filtered OUT must still be offered, at zero.
      // Vanishing from the panel the moment you use it is how a filter
      // becomes impossible to widen again.
      const counts = grid.facetCounts(
        [{ g: ["Guild"] }, { g: ["Council"] }],
        [{ g: ["Guild"] }],
        "g"
      );
      check(
        "a filtered-out option stays on the list at zero",
        counts.length === 2 &&
          counts.find((c) => c.value === "Council").count === 0
      );

      // Search reads the COLUMNS, not the row's own keys — finding a row
      // on a field you cannot see anywhere reads as a broken search.
      check(
        "search reads only the fields the table has",
        grid.searchText({ name: "Kelja", secret: "a traitor" }, [
          { key: "name" },
        ]) === "kelja"
      );
      check(
        "and reads numbers, which are values people search for",
        grid.searchText({ n: 12 }, [{ key: "n" }]) === "12"
      );
      // A formatted column is searchable BOTH ways. Typing what is on
      // the screen and not finding it is the failure worth avoiding;
      // typing the bare number has to keep working too, because that
      // is what somebody who knows the data types.
      {
        const hay = grid.searchText({ number: 7 }, [
          { key: "number", format: (r) => `Session ${r}` },
        ]);
        check("a formatted column is searchable by what it shows", hay.includes("session 7"));
        check("and by what it stores", hay.includes("7"));
      }
      check(
        "a blank formatted column puts no stray word in the haystack",
        grid.searchText({ number: null }, [
          { key: "number", format: (r) => `Session ${r}` },
        ]) === ""
      );

      // The same rule on the cell: a formatter must not put a word in
      // front of nothing, or an empty row reads as "Session " rather
      // than as the gap it is.
      check(
        "a formatted cell shows what the formatter says",
        grid.display({ number: 7 }, "number", (r) => `Session ${r}`) ===
          "Session 7"
      );
      check(
        "and stays blank when the value is",
        grid.display({ number: null }, "number", (r) => `Session ${r}`) === ""
      );
    }

    // ---- what a typed session cell becomes -------------------------
    // `Number("")` is 0 and `Number("seven")` is NaN, and either stored
    // is worse than the edit not landing: a cell reading "NaN" sorts
    // unpredictably and there is no way to type your way out of it.
    {
      const sc = await import(
        pathToFileURL(
          join(compile("components/sessionColumns.ts"), "sessionColumns.js")
        ).href
      );

      check(
        "a number is a number",
        sc.sessionPatch("xp", " 450 ").xp === 450
      );
      check(
        "a blank clears an optional number",
        sc.sessionPatch("xp", "  ").xp === null
      );
      // The session number is not optional, so clearing it would remove
      // the field the row is identified by.
      check(
        "a blank session number patches nothing at all",
        Object.keys(sc.sessionPatch("number", "")).length === 0
      );
      check(
        "a word where a number goes patches nothing",
        Object.keys(sc.sessionPatch("xp", "seven")).length === 0 &&
          Object.keys(sc.sessionPatch("number", "seven")).length === 0
      );
      check(
        "and Infinity is not a session number either",
        Object.keys(sc.sessionPatch("number", "1e400")).length === 0
      );

      check(
        "attendance splits on commas and drops the gaps",
        sc.sessionPatch("players", " Ana , ,Bo, ").players.join("|") ===
          "Ana|Bo"
      );
      check(
        "clearing attendance is an empty list, not a missing field",
        Array.isArray(sc.sessionPatch("players", "").players) &&
          sc.sessionPatch("players", "").players.length === 0
      );

      check(
        "a blank text field is cleared rather than stored empty",
        sc.sessionPatch("description", "   ").description === null
      );
      check(
        "and text is trimmed on the way in",
        sc.sessionPatch("date", " 2026-08-24 ").date === "2026-08-24"
      );

      // The two lists that decide what the screen can do have to name
      // real columns; a facet or a sort key that is not one shows up as
      // an unlabelled option that groups everything under "—".
      const keys = sc.SESSION_COLUMNS.map((c) => c.key);
      check(
        "every facet key is a column",
        sc.SESSION_FACET_KEYS.every((k) => keys.includes(k))
      );
      check(
        "the primary column and the default sort are columns",
        keys.includes(sc.SESSION_PRIMARY_COLUMN) &&
          keys.includes(sc.SESSION_DEFAULT_SORT.key)
      );
      // Newest first. A session log is a diary: the one you are about to
      // write up is the last one you played.
      check(
        "the log opens on the most recent night",
        sc.SESSION_DEFAULT_SORT.asc === false
      );

      // ---- who the attendance field offers ------------------------
      // Two sources, because neither alone is the table: members are
      // the accounts, and a character carries the name of a player who
      // never made one.
      check(
        "both sources are offered, once each",
        sc
          .campaignPlayers(
            [{ displayName: "Ana" }, { displayName: "Bo" }],
            [{ playerName: "Bo" }, { playerName: "Cy" }]
          )
          .join() === "Ana,Bo,Cy"
      );
      check(
        "matching a name ignores case and spacing",
        sc
          .campaignPlayers([{ displayName: "  ana  " }], [{ playerName: "ANA" }])
          .length === 1
      );
      check(
        "a blank name is not a player",
        sc.campaignPlayers([{ displayName: "" }, { displayName: null }], [{}])
          .length === 0
      );
      // Both queries are undefined until they resolve, and the field
      // renders before they do.
      check(
        "nothing loaded yet is no options, not a crash",
        sc.campaignPlayers(undefined, undefined).length === 0
      );

      // ---- and who it stops offering ------------------------------
      //
      // Somebody who left at session 30 should not be the first
      // suggestion when you write up session 60. Both sources have to
      // drop them or the name comes back through the other one.
      check(
        "an inactive character's player is not offered",
        sc
          .campaignPlayers(
            [],
            [{ playerName: "Ana" }, { playerName: "Bo", active: false }]
          )
          .join() === "Ana"
      );
      check(
        "nor through the account, when every sheet they own is retired",
        sc
          .campaignPlayers(
            [{ userId: "u1", displayName: "Bo" }],
            [{ playerId: "u1", playerName: "Bo", active: false }]
          ).length === 0
      );
      // Retiring a character and rolling a new one is the most ordinary
      // thing in a long campaign, and it is not leaving.
      // Both orders, because "does this player have a live sheet" is a
      // fold over their rows and a fold that keeps the LAST answer
      // instead of ORing them is right half the time — which is the
      // half a single fixture would have picked.
      //
      // The sheets carry NO playerName, so "Bo" can only have come
      // through the account. With one on each row, the character loop
      // would supply the name whatever the fold decided, and the test
      // would pass while testing nothing.
      for (const order of [
        [false, true],
        [true, false],
      ]) {
        check(
          `one live sheet keeps a player on the list (${order.join(",")})`,
          sc
            .campaignPlayers(
              [{ userId: "u1", displayName: "Bo" }],
              order.map((active) => ({ playerId: "u1", active }))
            )
            .join() === "Bo"
        );
      }

      // ---- and the predicate underneath it ------------------------
      // Tested directly as well as through campaignPlayers, because
      // the two loops there can cover for each other: a name dropped
      // by one is put back by the other, and the union comes out
      // right while neither half is.
      const rm = await import(
        pathToFileURL(
          join(compile("components/rosterModel.ts"), "rosterModel.js")
        ).href
      );
      check(
        "absent means active, and so does an explicit true",
        rm.isActive({}) && rm.isActive({ active: true })
      );
      check("only false is inactive", rm.isActive({ active: false }) === false);
      check(
        "an account whose every sheet is retired is retired",
        rm.retiredPlayerIds([{ playerId: "u1", active: false }]).has("u1")
      );
      for (const order of [
        [false, true],
        [true, false],
      ]) {
        check(
          `one live sheet and the account is not retired (${order.join(",")})`,
          rm.retiredPlayerIds(
            order.map((active) => ({ playerId: "u1", active }))
          ).size === 0
        );
      }
      check(
        "a sheet with no account retires nobody",
        rm.retiredPlayerIds([{ active: false }]).size === 0
      );
      check(
        "and neither does a list that has not loaded",
        rm.retiredPlayerIds(undefined).size === 0
      );
      // There is nowhere to mark such a person inactive — the roster IS
      // the character list — so having no character must not read as
      // having left.
      check(
        "a member with no character at all is still offered",
        sc
          .campaignPlayers([{ userId: "u9", displayName: "Cy" }], [])
          .join() === "Cy"
      );
      // Every row in the database predates the field. A truthiness test
      // here would retire the entire party the day it shipped.
      check(
        "a character from before the field existed is active",
        sc.campaignPlayers([], [{ playerName: "Dot" }]).join() === "Dot" &&
          sc
            .campaignPlayers(
              [{ userId: "u2", displayName: "Eli" }],
              [{ playerId: "u2", playerName: "Eli" }]
            )
            .join() === "Eli"
      );
      check(
        "and one marked active explicitly is too",
        sc
          .campaignPlayers([], [{ playerName: "Fay", active: true }])
          .join() === "Fay"
      );
      // The flag hides suggestions; it is not a rule about names. A
      // guest who played one night is still attendance, and a name
      // already typed on a past session is untouched by any of this.
      check(
        "an inactive character with no player name changes nothing",
        sc.campaignPlayers([{ displayName: "Gus" }], [{ active: false }])
          .join() === "Gus"
      );

      // Toggling one name off a line of five is where the stored array
      // and the typed line have to agree exactly.
      check(
        "a name not on the line goes on the end",
        sc.toggleChip("Ana, Bo", "Cy") === "Ana, Bo, Cy"
      );
      check(
        "a name already on it comes off",
        sc.toggleChip("Ana, Bo, Cy", "Bo") === "Ana, Cy"
      );
      check(
        "and comes off whatever case it was typed in",
        sc.toggleChip("ana, Bo", "ANA") === "Bo"
      );
      check(
        "toggling onto an empty line is just the name",
        sc.toggleChip("", "Ana") === "Ana"
      );
      check(
        "and the last one off leaves nothing",
        sc.toggleChip("Ana", "Ana") === ""
      );
      // Which sessionPatch then has to read back as an empty list
      // rather than as a list holding one empty string.
      check(
        "an emptied line stores an empty attendance",
        sc.sessionPatch("players", sc.toggleChip("Ana", "Ana")).players
          .length === 0
      );

      // The primary column is a NUMBER, and a column of bare digits
      // under a heading reads as row numbers rather than as sessions.
      // Reported once already, so it is asserted rather than trusted.
      const primary = sc.SESSION_COLUMNS.find(
        (c) => c.key === sc.SESSION_PRIMARY_COLUMN
      );
      check(
        "a session names itself in its own cell",
        typeof primary.format === "function" && primary.format(7) === "Session 7"
      );
      // And it is still a number underneath, or the column would sort
      // 10 between 1 and 2.
      check(
        "which is a label, not the stored value",
        primary.kind === "number"
      );
    }

    // ---- how a campaign levels -------------------------------------
    // XP and milestone are one slot with two fields, and the milestone
    // dropdown's options depend on every other session — the two rules
    // where a wrong answer writes a level history that cannot have
    // happened.
    {
      const sc = await import(
        pathToFileURL(
          join(compile("components/sessionColumns.ts"), "sessionColumns.js")
        ).href
      );

      const keys = (mode) => sc.sessionColumnsFor(mode).map((c) => c.key);
      check(
        "an xp campaign has XP Awarded and no milestone column",
        keys("xp").includes("xp") && !keys("xp").includes("milestone")
      );
      check(
        "a milestone campaign has it the other way round",
        keys("milestone").includes("milestone") &&
          !keys("milestone").includes("xp")
      );
      check(
        "the two modes otherwise show the same fields",
        JSON.stringify(keys("xp").filter((k) => k !== "xp")) ===
          JSON.stringify(keys("milestone").filter((k) => k !== "milestone"))
      );

      // Derek's own example, verbatim: session 5 reached level 5, so
      // every later session offers 6 through 20.
      const S = (number, milestone) => ({ number, milestone });
      const after5 = sc.milestoneOptions([S(5, 5)], 6);
      check(
        "after a session reaches 5, later sessions offer 6 through 20",
        after5[0] === 6 &&
          after5[after5.length - 1] === 20 &&
          after5.length === 15
      );
      check(
        "a level another session recorded is not on offer",
        !sc.milestoneOptions([S(3, 4), S(5, 7)], 8).includes(7) &&
          !sc.milestoneOptions([S(3, 4), S(5, 7)], 8).includes(4)
      );
      // A LATER session's level, specifically: for an earlier session
      // the floor says nothing, so the used-set is the only thing
      // stopping two sessions from both being the night the party hit
      // 8. The first version of this block only ever tested levels the
      // floor already excluded, and deleting the used-set passed.
      check(
        "a level a later session recorded is not on offer either",
        !sc.milestoneOptions([S(10, 8)], 4).includes(8)
      );
      check(
        "levels do not go back down",
        sc
          .milestoneOptions([S(5, 5)], 6)
          .every((l) => l > 5)
      );
      // An EARLIER session is not fenced by a later one's level: the
      // floor only looks backwards, so back-filling old sessions works.
      check(
        "an earlier session may still record a lower level",
        sc.milestoneOptions([S(10, 8)], 4).includes(3)
      );
      // The own-value rule earns its keep only when the value would
      // OTHERWISE be excluded — a back-filled session whose level sits
      // under a later-numbered session's floor. The first fixture's
      // value was offered anyway, and deleting the rule passed.
      check(
        "a session's own value stays pickable even under the floor",
        sc.milestoneOptions([S(5, 7)], 6, 6).includes(6)
      );
      check(
        "level 1 is never on offer — campaigns start there",
        !sc.milestoneOptions([], 1).includes(1) &&
          sc.milestoneOptions([], 1)[0] === 2
      );
      check(
        "a fresh campaign offers all of 2 through 20",
        sc.milestoneOptions([], 1).length === 19
      );

      check(
        "a picked level patches as a number",
        sc.sessionPatch("milestone", "7").milestone === 7
      );
      check(
        "clearing the pick clears the field",
        sc.sessionPatch("milestone", "").milestone === null
      );
    }

    // ---- a book, written out ---------------------------------------
    // A Foundry export stores the abbreviation, which is what a
    // compendium key looks like rather than what a book is called.
    {
      const src = await import(
        pathToFileURL(
          join(compile("components/sourceNames.ts"), "sourceNames.js")
        ).href
      );

      check(
        "a book this app knows is written out",
        src.expandSource("PHB") === "Player's Handbook" &&
          src.expandSource("MotM") === "Monsters of the Multiverse"
      );
      // The important half. A book nobody wrote down here keeps its
      // abbreviation, which is what the column already showed — never
      // worse than before, and never a guess.
      check(
        "a book it does not know keeps its abbreviation",
        src.expandSource("ZZZ") === "ZZZ"
      );
      check(
        "and nothing is nothing, not a stray word",
        src.expandSource("") === "" && src.expandSource(null) === ""
      );
      // The printing year is the whole reason the Source column is
      // worth reading in a library holding both editions.
      check(
        "the year stays on the end",
        src.expandSource("PHB 2024") === "Player's Handbook 2024"
      );

      // A printing is a year OR a version. The importer writes the
      // reference document as `SRD` plus dnd5e's `source.rules`, which
      // is "2014" in some versions of the system and "5.1" in others —
      // so matching only the year left the single most common source in
      // a stock library sitting there as three letters.
      check(
        "a version on the end is a printing too",
        src.expandSource("SRD 5.1") === "System Reference Document 5.1" &&
          src.expandSource("SRD 2014") === "System Reference Document 2014"
      );
      check(
        "and a longer one, in case the SRD ever gets a third number",
        src.expandSource("SRD 5.2.1") === "System Reference Document 5.2.1"
      );
      // Taking a suffix off is only ever a way to find a KNOWN book, so
      // widening what counts as one cannot turn a miss into a hit.
      check(
        "a book it does not know still keeps its printing untouched",
        src.expandSource("ZZZ 5.1") === "ZZZ 5.1"
      );
      check(
        "and an unknown book keeps its year too",
        src.expandSource("ZZZ 2024") === "ZZZ 2024"
      );

      // The books Derek sent back after running the sources report.
      // Written out one by one rather than counted: a map entry is a
      // string somebody typed, and the way it goes wrong is a name that
      // looks plausible beside a code that does not match it.
      for (const [code, name] of [
        ["FRHoF", "Forgotten Realms: Heroes of Faer\u00fbn"],
        ["TBoMT", "The Book of Many Things"],
        ["IDRotF", "Icewind Dale: Rime of the Frostmaiden"],
        ["SACoC", "Strixhaven: A Curriculum of Chaos"],
        ["EE", "Elemental Evil Player's Companion"],
        ["EFotA", "Eberron: Forge of the Artificer"],
        ["PAitM", "Planescape: Adventures in the Multiverse"],
        ["DMLS", "Dungeon Masters: Living Spells"],
        ["BGDiA", "Baldur's Gate: Descent into Avernus"],
        ["GotG", "Bigby Presents: Glory of the Giants"],
        ["CoSCO", "Curse of Strahd: Character Options"],
        ["LFL", "Lorwyn: First Light"],
        ["MOoT", "Mythic Odysseys of Theros"],
        ["SotDQ", "Dragonlance: Shadow of the Dragon Queen"],
        ["TWBtW", "The Wild Beyond the Witchlight"],
      ]) {
        check(`${code} is written out as ${name}`, src.expandSource(code) === name);
      }

      // Two Eberron books, and the older one is the one already in the
      // map — so the copy-paste that gives the new code the old name is
      // the mistake available here, and it reads perfectly.
      check(
        "the two Eberron books are two books",
        src.expandSource("EFotA") !== src.expandSource("ERLW")
      );

      // A book in the map that the COLUMN still shows as a code is a
      // book nobody added. The width-aware fallback is right — a
      // clipped title says less than an abbreviation — but it meant
      // four of these six read exactly as they had before, and the
      // only way to notice was to go and look at the table.
      // EVERY book, not the ones most recently added. The column was
      // widened twice to fit whatever had just gone in, and each time
      // the next book to be added silently did not fit: it went in the
      // map, changed nothing on screen, and had to be caught by eye.
      // This recomputes over the whole map and names the offender.
      {
        const px = src.trackPx(look.SOURCE_COLUMN.width);
        const tooWide = Object.keys(src.SOURCE_NAMES).filter(
          (code) => src.sourceLabel(code, px) !== src.expandSource(code)
        );
        check(
          tooWide.length === 0
            ? "every book in the map fits the Source column"
            : `these books do not fit the ${look.SOURCE_COLUMN.width} Source ` +
                `column and would still read as codes: ${tooWide.join(", ")}`,
          Boolean(px) && tooWide.length === 0
        );
      }
      // And the fallback still fires when the column is dragged
      // narrower, or the check above would be satisfied by a column
      // that had simply stopped measuring anything.
      check(
        "a title too long for the space still falls back to its code",
        src.sourceLabel("PaBTSO", 120) === "PaBTSO"
      );

      // ---- one book, however a row spells it ----------------------
      // What the Sources setting switches on. Three strings, one book.
      check(
        "a printing does not make a second book",
        src.sourceKey("PHB") === "Player's Handbook" &&
          src.sourceKey("PHB 2014") === "Player's Handbook" &&
          src.sourceKey("PHB 2024") === "Player's Handbook"
      );
      check(
        "and neither does a second abbreviation",
        src.sourceKey("EEPC") === src.sourceKey("EE")
      );
      check(
        "a book with no name keys as its own code",
        src.sourceKey("ZZZ") === "ZZZ"
      );
      // The same conditional strip the report uses: prose ending in a
      // number is not a book with a printing.
      check(
        "free text keeps its trailing number",
        src.sourceKey("Derek's notes, session 12") ===
          "Derek's notes, session 12"
      );
      check("nothing keys as nothing", src.sourceKey(null) === "");

      // One row per BOOK, not per code — a list built off the keys
      // would offer Elemental Evil twice, and switching one of them
      // off would hide half its rows and read as a broken filter.
      {
        const books = src.sourceBooks();
        const names = books.map((b) => b.name);
        check(
          "the book list has no duplicates",
          new Set(names).size === names.length
        );
        check(
          "it is in name order, which is the order it is read in",
          JSON.stringify(names) === JSON.stringify([...names].sort())
        );
        const ee = books.find((b) => b.name.startsWith("Elemental Evil"));
        check(
          "a book with two codes is one row carrying both",
          Boolean(ee) &&
            ee.codes.includes("EE") &&
            ee.codes.includes("EEPC")
        );
        check(
          "every code in the map reaches a row",
          Object.keys(src.SOURCE_NAMES).every((code) =>
            books.some((b) => b.codes.includes(code))
          )
        );
      }

      // ---- books switched off in Settings -------------------------
      const shelf = [
        { name: "Fireball", source: "PHB" },
        { name: "Fireball", source: "PHB 2024" },
        { name: "Hoard Bag", source: "AI" },
        { name: "Aura of Life", source: "EEPC" },
        { name: "Ice Knife", source: "EE" },
        { name: "Odd Thing", source: "ZZZ" },
      ];
      const kept = (off) =>
        look.applySourceFilter(shelf, off).map((r) => r.name);

      check(
        "nothing switched off changes nothing",
        look.applySourceFilter(shelf, []) === shelf
      );
      check(
        "switching a book off takes every printing of it",
        !kept(["Player's Handbook"]).includes("Fireball") &&
          kept(["Player's Handbook"]).length === 4
      );
      // The reason the setting stores names: EEPC and EE are one book,
      // and switching it off has to take both spellings with it.
      check(
        "and every abbreviation of it",
        (() => {
          const left = kept(["Elemental Evil Player's Companion"]);
          return !left.includes("Aura of Life") && !left.includes("Ice Knife");
        })()
      );
      check(
        "a book nobody switched off is untouched",
        kept(["Acquisitions Incorporated"]).includes("Fireball")
      );
      check(
        "a book with no name can still be switched off by its code",
        !kept(["ZZZ"]).includes("Odd Thing")
      );
      // The source can be in the NAME rather than the field — every
      // other reader here allows for that, and one that did not would
      // quietly spare those rows from a switch somebody had thrown.
      check(
        "a book written into the name is switched off too",
        look.applySourceFilter(
          [{ name: "Fireball (PHB)", source: "" }],
          ["Player's Handbook"]
        ).length === 0
      );

      // Where one book has two codes, both have to say the same thing.
      // A typo in the second is INVISIBLE to a list grouped by name,
      // because it makes two rows rather than one: "The Book of Many
      // Things" beside "Book of Many Things" reads as two books, and
      // switching off the one you can see hides half the rows.
      //
      // Checked by normalising every name rather than by listing the
      // pairs. The list was ten pairs and became eighteen in a single
      // message — a check somebody has to extend is a check that will
      // one day not be extended.
      {
        const norm = (n) =>
          n.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
        const twinsIn = (names) => {
          const first = new Map();
          const twins = [];
          for (const name of names) {
            const key = norm(name);
            const already = first.get(key);
            if (already) twins.push(`"${already}" / "${name}"`);
            else first.set(key, name);
          }
          return twins;
        };

        const twins = twinsIn(src.sourceBooks().map((b) => b.name));
        check(
          twins.length === 0
            ? "no two books are one book spelt two ways"
            : `these are the same book under two spellings, which is a typo ` +
                `in an alias: ${twins.join("; ")}`,
          twins.length === 0
        );

        // The detector, tested on its own. Everything this check is
        // worth is in that normalisation, and a mutation that simply
        // deleted half of it left the whole thing passing — a weakened
        // heuristic looks exactly like a heuristic finding nothing.
        check(
          "a dropped article is caught",
          twinsIn(["The Book of Many Things", "Book of Many Things"]).length === 1
        );
        check(
          "so is a dropped colon",
          twinsIn([
            "Bigby Presents: Glory of the Giants",
            "Bigby Presents Glory of the Giants",
          ]).length === 1
        );
        // And the direction that matters just as much: a detector that
        // flagged a book beside its own supplement would fire on every
        // real map, and a check that always fails gets deleted.
        check(
          "a book and its supplement are two books",
          twinsIn([
            "Curse of Strahd",
            "Curse of Strahd: Character Options",
          ]).length === 0
        );
      }

      // Too narrow for the name, so the abbreviation comes back: a
      // clipped book title says less than a code does.
      check(
        "a wide column gets the name",
        src.sourceLabel("PHB", 300) === "Player's Handbook"
      );
      // The default width, against the titles that actually turn up.
      // Measured in the browser at 0.84rem: Van Richten's is 220px on
      // screen and Monsters of the Multiverse 179, so a 16rem column
      // takes both.
      check(
        "the default column takes the long common titles",
        src.sourceLabel("VRGtR", 256) === "Van Richten's Guide to Ravenloft" &&
          src.sourceLabel("MotM", 256) === "Monsters of the Multiverse"
      );
      check(
        "a narrow one gets the abbreviation",
        src.sourceLabel("PHB", 60) === "PHB"
      );
      check(
        "an unmeasurable column writes it out",
        src.sourceLabel("PHB", null) === "Player's Handbook"
      );
      // A book with no expansion has nothing to shorten back TO, so the
      // width cannot make it any shorter.
      check(
        "an unknown book is itself at any width",
        src.sourceLabel("ZZZ", 20) === "ZZZ"
      );

      check(
        "a rem track is measured",
        src.trackPx("7rem") === 112 && src.trackPx("140px") === 140
      );
      check(
        "and a track that is not a length is not guessed at",
        src.trackPx("minmax(11rem, 2fr)") === null && src.trackPx("") === null
      );
    }

    // ---- what a session's note box may contain ---------------------
    // The notebook's boxes are private, so their HTML round-tripped
    // untouched. A session's player notes are written by any member and
    // read by the GM, which makes them the same problem notes already
    // solved — and a wider vocabulary, because the format toolbar puts
    // colours and alignment on the text.
    {
      const bh = await import(
        pathToFileURL(join(compile("components/boxHtml.ts"), "boxHtml.js")).href
      );

      const clean = (h) => bh.sanitizeBoxHtml(h);

      check(
        "a script is gone, body and all",
        clean("<p>hi</p><script>alert(1)</script>") === "<p>hi</p>"
      );
      check(
        "an event handler is not an attribute this emits",
        !clean('<p onclick="alert(1)">hi</p>').includes("onclick")
      );
      check(
        "an image cannot ask for a url",
        clean('<img src="http://x/pixel.gif">') === ""
      );

      // The format toolbar's own output has to survive, or sanitising
      // the box is the same as deleting the formatting.
      check(
        "a colour survives",
        clean('<span style="color: #c9a227">gold</span>') ===
          '<span style="color: #c9a227">gold</span>'
      );
      check(
        "so does an alignment and an rgb()",
        clean('<div style="text-align: center; color: rgb(1, 2, 3)">x</div>')
          .includes("text-align: center")
      );
      check(
        "and a font face and size",
        clean('<font face="Georgia" size="4">x</font>') ===
          '<font face="Georgia" size="4">x</font>'
      );

      // style is a whole language and most of it does not belong here.
      check(
        "a style that can fetch is refused",
        !clean('<p style="background: url(http://x/p.gif)">x</p>').includes("url")
      );
      check(
        "and one that can cover the screen",
        !clean('<p style="position: fixed; top: 0">x</p>').includes("position")
      );
      check(
        "a declaration that is allowed survives beside one that is not",
        clean('<p style="position: fixed; color: red">x</p>') ===
          '<p style="color: red">x</p>'
      );

      // Links. These go through the router to a page in this app, so an
      // app route is the only kind this emits.
      check(
        "an app route survives with its kind",
        clean('<a data-gm="npc" href="/campaign/abc/npcs?open=Kelja">K</a>') ===
          '<a href="/campaign/abc/npcs?open=Kelja" data-gm="npc">K</a>'
      );
      // The bug this test was written for: `[ -]` is a RANGE from space
      // to hyphen, and "%" is inside it — so every url-encoded name was
      // refused and every link with a space in it lost its href.
      check(
        "a url-encoded name is still an app route",
        clean(
          '<a href="/campaign/abc/npcs?open=Kelja%20Ironfist">K</a>'
        ).includes("Kelja%20Ironfist")
      );
      check(
        "javascript: is not a route",
        !clean('<a href="javascript:alert(1)">x</a>').includes("href")
      );
      check(
        "nor is somewhere else entirely",
        !clean('<a href="https://evil.example">x</a>').includes("href")
      );
      // The one that looks like an app route and is not: a
      // protocol-relative url starts with a slash too.
      check(
        "and neither is a protocol-relative url",
        !clean('<a href="//evil.example">x</a>').includes("href")
      );
      check(
        "a kind that is not a word cannot reach the route builder",
        !clean('<a data-gm="../../etc" href="/x">y</a>').includes("data-gm")
      );
      check(
        "the words are kept even when the tag is not",
        clean("<marquee>still here</marquee>") === "still here"
      );
    }

    // ---- where a link in the notes goes ----------------------------
    {
      const nl = await import(
        pathToFileURL(join(compile("components/noteLinks.ts"), "noteLinks.js"))
          .href
      );

      check(
        "each kind goes to its own screen",
        nl.linkHref("c1", "npc", "Kelja") === "/campaign/c1/npcs?open=Kelja" &&
          nl.linkHref("c1", "location", "Mines") ===
            "/campaign/c1/locations?open=Mines" &&
          nl.linkHref("c1", "group", "Guild") ===
            "/campaign/c1/groups?open=Guild" &&
          nl.linkHref("c1", "species", "Elf") ===
            "/campaign/c1/lookup?tab=species&open=Elf"
      );
      // Named per kind rather than reached by an else-branch, which is
      // the mistake the NPC grid made once: every kind it did not name
      // went somewhere plausible and wrong.
      check(
        "a kind nothing names goes NOWHERE, not somewhere plausible",
        nl.linkHref("c1", "shop", "Anvil") === null
      );
      check(
        "a name with a space is encoded, not broken in half",
        nl.linkHref("c1", "npc", "Kelja Ironfist") ===
          "/campaign/c1/npcs?open=Kelja%20Ironfist"
      );
      check(
        "a blank name is not a link",
        nl.linkHref("c1", "npc", "   ") === null
      );

      // The anchor is handed to insertHTML, so it is escaped HERE —
      // before any mutation has a chance to rebuild it.
      check(
        "a name that looks like markup is escaped on the way in",
        nl.linkHtml("c1", { kind: "npc", name: "A <b>Bold</b> One" }).includes(
          "A &lt;b&gt;Bold&lt;/b&gt; One"
        )
      );
      check(
        "and the anchor says which kind it is",
        nl
          .linkHtml("c1", { kind: "group", name: "Guild" })
          .includes('data-gm="group"')
      );

      const TARGETS = [
        { kind: "npc", name: "Bruno Ironfist" },
        { kind: "npc", name: "Ambruster" },
        { kind: "group", name: "Mining Guild" },
      ];
      check(
        "a match nearer the start of the name comes first",
        nl.matchTargets(TARGETS, "bru").map((t) => t.name).join() ===
          "Bruno Ironfist,Ambruster"
      );
      check(
        "matching ignores case",
        nl.matchTargets(TARGETS, "MINING").length === 1
      );
      check(
        "an empty query offers everything, up to the cap",
        nl.matchTargets(TARGETS, "").length === 3 &&
          nl.matchTargets(TARGETS, "", 2).length === 2
      );

      check(
        "the three lists become one list of targets",
        nl
          .linkTargets({
            npcs: [{ name: "Kelja" }],
            locations: [{ name: "Mines" }],
            groups: [{ name: "Guild" }],
          })
          .length === 3
      );
      check(
        "a nameless row is not offered",
        nl.linkTargets({ npcs: [{ name: "" }, { name: null }, {}] }).length === 0
      );
      // The same name in two KINDS is two targets; twice in one kind is
      // one.
      check(
        "a name in two kinds is two targets",
        nl.linkTargets({ npcs: [{ name: "Moonbrook" }], locations: [{ name: "Moonbrook" }] })
          .length === 2
      );
      check(
        "and the same name twice in one kind is one",
        nl.linkTargets({ npcs: [{ name: "Kelja" }, { name: "kelja" }] }).length === 1
      );
      check(
        "nothing loaded yet is no targets, not a crash",
        nl.linkTargets({}).length === 0
      );

      // The two halves have to agree: what linkHtml writes is what the
      // sanitiser lets through, or every link is stripped on save.
      const bh = await import(
        pathToFileURL(join(compile("components/boxHtml.ts"), "boxHtml.js")).href
      );
      check(
        "a link this app writes survives the sanitiser it is saved through",
        (() => {
          const html = nl.linkHtml("c1", {
            kind: "npc",
            name: "Kelja Ironfist",
          });
          const out = bh.sanitizeBoxHtml(html);
          return (
            out.includes("/campaign/c1/npcs?open=Kelja%20Ironfist") &&
            out.includes('data-gm="npc"')
          );
        })()
      );

      // What typing `#` actually saves: the anchor plus the trailing
      // non-breaking space that keeps the caret outside it. Checked as
      // a whole, because the sanitiser is a rebuild — it is perfectly
      // capable of keeping the link and dropping the space, which puts
      // the next word inside the link on the next reload.
      check(
        "the space that ends an inserted link survives the sanitiser",
        (() => {
          const inserted = `${nl.linkHtml("c1", {
            kind: "npc",
            name: "Kelja Ironfist",
          })}&nbsp;took the deal`;
          const out = bh.sanitizeBoxHtml(inserted);
          return (
            out.includes("</a>") &&
            /<\/a>(&nbsp;| )took the deal/.test(out)
          );
        })()
      );

      // The sanitiser reads HTML, and a browser's innerHTML is full of
      // entities. It used to escape the `&` of every one of them, so a
      // space before a link came back as the letters "&nbsp;" — and an
      // ampersand somebody typed grew another "amp;" on EVERY save,
      // which is the failure that compounds rather than merely looking
      // wrong once.
      const round = (html) => bh.sanitizeBoxHtml(html);
      check(
        "a non-breaking space stays a space",
        round("a&nbsp;b") === "a&nbsp;b"
      );
      check(
        "an escaped ampersand does not grow, however many times it is saved",
        round("Smith &amp; Sons") === "Smith &amp; Sons" &&
          round(round(round("Smith &amp; Sons"))) === "Smith &amp; Sons"
      );
      check(
        "numeric entities survive too, in both spellings",
        round("a&#160;b&#xA0;c") === "a&#160;b&#xA0;c"
      );
      check(
        "a bare ampersand is still escaped",
        round("Smith & Sons") === "Smith &amp; Sons"
      );
      check(
        "and so is one that only looks like the start of an entity",
        round("&notanentity and &amp") === "&amp;notanentity and &amp;amp"
      );
      // Why leaving entities alone is safe: an entity cannot open a
      // tag. It renders as the character, never as markup.
      check(
        "an escaped angle bracket stays text rather than becoming a tag",
        round("5 &lt;script&gt; 6") === "5 &lt;script&gt; 6"
      );
      check(
        "and a real script tag is still taken out",
        !/script/i.test(round("hi <script>alert(1)</script> there"))
      );
    }

    // ---- the GM Screen's windows -----------------------------------
    // The tiling tree: drop zones, splits, shares, and the parser
    // every stored layout comes through. The failures here are all
    // invisible in a demo: a drop zone that reads the wrong edge, a
    // share sum that drifts off 1 so windows shrink from the right,
    // a saved layout from last month that crashes the screen open.
    {
      const dm = await import(
        pathToFileURL(
          join(compile("components/dmScreenModel.ts"), "dmScreenModel.js")
        ).href
      );
      // 1206 wide = two 600px halves + one 6px divider: the arithmetic
      // below comes out in whole numbers on purpose.
      const VIEW = { w: 1206, h: 800 };
      const NOTES = new Set(["n1"]);
      const group = (id, kinds, active = 0) => ({
        type: "group",
        id,
        tabs: kinds.map((kind) => ({ kind })),
        active,
      });
      const store = (root, nextId, focused = null) =>
        JSON.stringify({ root, nextId, focused });

      // Round trip: what serialize writes, parse reads back whole.
      const start = dm.defaultLayout();
      check(
        "a layout survives the round trip through storage",
        JSON.stringify(dm.parseLayout(dm.serializeLayout(start), NOTES)) ===
          JSON.stringify(start)
      );
      check(
        "garbage parses to null rather than a crash or a screen",
        dm.parseLayout("{not json", NOTES) === null &&
          dm.parseLayout('{"root": 7}', NOTES) === null &&
          dm.parseLayout(null, NOTES) === null
      );
      // A layout from the floating era has no faithful place in a
      // tiling — the default steps in rather than a guessed conversion.
      check(
        "a floating-era layout parses to null, not a guess",
        dm.parseLayout(
          JSON.stringify({
            panels: [{ id: 1, x: 5, y: 5, w: 300, h: 200, tabs: [{ kind: "chat" }], active: 0 }],
            nextId: 2,
          }),
          NOTES
        ) === null
      );
      // The reason parseLayout exists: stored kinds the app no longer
      // has, and notes deleted elsewhere, are dropped rather than
      // rendered as broken windows — and the space they held goes to
      // their siblings, never to the background.
      check(
        "an unknown kind and a dead note are dropped, their window's share absorbed",
        (() => {
          const raw = store(
            {
              type: "split",
              id: 9,
              dir: "row",
              children: [
                group(1, ["monsters"]),
                { type: "group", id: 2, tabs: [{ kind: "widget" }, { kind: "note", noteId: "gone" }], active: 0 },
                group(3, ["chat", "widget"], 1),
              ],
              sizes: [0.25, 0.25, 0.5],
            },
            10
          );
          const out = dm.parseLayout(raw, NOTES);
          if (!out || out.root.type !== "split") return false;
          const rects = dm.layoutRects(out, VIEW);
          const r1 = rects.get(1);
          return (
            out.root.children.length === 2 &&
            out.root.children[1].tabs.length === 1 &&
            out.root.children[1].active === 0 &&
            Math.abs(out.root.sizes[0] + out.root.sizes[1] - 1) < 1e-9 &&
            r1 !== undefined &&
            Math.abs(r1.w - 1200 / 3) < 0.001
          );
        })()
      );
      check(
        "a layout with nothing left in it is null, so the default steps in",
        dm.parseLayout(store(group(1, ["widget"]), 2), NOTES) === null
      );
      check(
        "a split left holding one child collapses into that child",
        (() => {
          const out = dm.parseLayout(
            store(
              {
                type: "split",
                id: 4,
                dir: "col",
                children: [group(1, ["chat"]), group(2, ["widget"])],
                sizes: [0.5, 0.5],
              },
              5
            ),
            NOTES
          );
          return out !== null && out.root.type === "group" && out.root.id === 1;
        })()
      );
      check(
        "duplicate ids are reassigned — a drop must never move two windows",
        (() => {
          const out = dm.parseLayout(
            store(
              {
                type: "split",
                id: 7,
                dir: "row",
                children: [group(5, ["chat"]), group(5, ["rules"])],
                sizes: [0.5, 0.5],
              },
              2
            ),
            NOTES
          );
          if (!out) return false;
          const ids = [out.root.id, ...out.root.children.map((c) => c.id)];
          return new Set(ids).size === 3 && out.nextId > Math.max(...ids);
        })()
      );
      check(
        "a focused group that no longer exists is let go",
        (() => {
          const out = dm.parseLayout(store(group(1, ["chat"]), 2, 99), NOTES);
          return out !== null && out.focused === null;
        })()
      );

      // The geometry: shares become rectangles, dividers counted.
      {
        const rects = dm.layoutRects(start, VIEW);
        const [r1, r2] = [rects.get(1), rects.get(2)];
        check(
          "two half shares land as two halves either side of the divider",
          r1.x === 0 && r1.w === 600 && r2.x === 606 && r2.w === 600 &&
            r1.h === 800 && r2.h === 800
        );
      }

      // The drop zones, Premiere's exactly: canvas edge first, then
      // the tab strip, then the middle box as a tab dock, then the
      // nearest quarter as a split.
      {
        check(
          "the canvas's own edge outranks whatever window sits against it",
          (() => {
            const t = dm.dropTargetAt(start, { x: 4, y: 400 }, VIEW, 34);
            const b = dm.dropTargetAt(start, { x: 300, y: 795 }, VIEW, 34);
            return (
              t !== null && t.type === "root" && t.edge === "left" &&
              b !== null && b.type === "root" && b.edge === "bottom"
            );
          })()
        );
        check(
          "the tab strip is a tab dock",
          (() => {
            const t = dm.dropTargetAt(start, { x: 100, y: 25 }, VIEW, 34);
            return t !== null && t.type === "tabs" && t.group === 1;
          })()
        );
        check(
          "the middle of a window stacks; its outer quarter splits",
          (() => {
            const mid = dm.dropTargetAt(start, { x: 300, y: 400 }, VIEW, 34);
            const side = dm.dropTargetAt(start, { x: 650, y: 400 }, VIEW, 34);
            return (
              mid !== null && mid.type === "tabs" && mid.group === 1 &&
              side !== null && side.type === "edge" &&
              side.group === 2 && side.edge === "left"
            );
          })()
        );
        // Matched to Premiere's screenshots by request: a side drop
        // lights a NARROW BAND in from the near edge, a tab drop the
        // strip at the top, a canvas-edge drop a thin line down that
        // side — never the window or the landing area, which reads as
        // "this window gets replaced".
        check(
          "the highlight is a band at the near edge, never the window",
          (() => {
            const r = dm.dropPreviewRect(
              start,
              { type: "edge", group: 1, edge: "right" },
              VIEW,
              34
            );
            const strip = dm.dropPreviewRect(
              start,
              { type: "tabs", group: 2 },
              VIEW,
              34
            );
            const dock = dm.dropPreviewRect(
              start,
              { type: "root", edge: "left" },
              VIEW,
              34
            );
            return (
              r.w === dm.EDGE_HINT_PX && r.h === 800 &&
              r.x === 600 - dm.EDGE_HINT_PX &&
              strip.x === 606 && strip.h === 34 && strip.w === 600 &&
              dock.x === 0 && dock.h === 800 && dock.w === dm.ROOT_HINT_PX
            );
          })()
        );
        check(
          "a narrow window still shows a band, not its whole self",
          (() => {
            const tiny = dm.dropPreviewRect(
              start,
              { type: "edge", group: 1, edge: "bottom" },
              { w: 240, h: 160 },
              34
            );
            const r1 = dm.layoutRects(start, { w: 240, h: 160 }).get(1);
            return tiny.h <= r1.h / 4 && tiny.y === r1.y + r1.h - tiny.h;
          })()
        );
      }

      // Stacking: a window dropped on a strip dissolves into it, the
      // first arrival on top, and its old space goes to a neighbour.
      {
        const merged = dm.moveGroup(start, 2, { type: "tabs", group: 1 });
        check(
          "a merge keeps every tab from both windows",
          merged.root.type === "group" && merged.root.tabs.length === 3
        );
        check(
          "the dropped window's first tab is the active one",
          merged.root.tabs[merged.root.active].kind === "monsters"
        );
        check(
          "dropping a window onto itself changes nothing",
          dm.moveGroup(start, 1, { type: "tabs", group: 1 }) === start &&
            dm.moveGroup(start, 1, { type: "edge", group: 1, edge: "left" }) ===
              start
        );
        check(
          "a tab dropped back on its own strip stays where it was",
          dm.moveTab(start, 2, 0, { type: "tabs", group: 2 }) === start
        );
      }

      // Splitting: dropping against a window's side takes half of it.
      {
        const split = dm.moveTab(start, 2, 1, {
          type: "edge",
          group: 1,
          edge: "bottom",
        });
        const left = split.root.children[0];
        check(
          "a drop on a window's side splits that window's own space",
          split.root.type === "split" &&
            left.type === "split" &&
            left.dir === "col" &&
            left.children[0].tabs[0].kind === "reference" &&
            left.children[1].tabs[0].kind === "spells" &&
            Math.abs(left.sizes[0] - 0.5) < 1e-9
        );
        check(
          "the new window is the focused one",
          split.focused === left.children[1].id
        );
        check(
          "the source stack keeps what was not moved",
          split.root.children[1].tabs.length === 1 &&
            split.root.children[1].tabs[0].kind === "monsters"
        );
      }
      check(
        "a drop along an existing run joins the run, never nests a frame",
        (() => {
          const three = dm.parseLayout(
            store(
              {
                type: "split",
                id: 9,
                dir: "row",
                children: [group(1, ["chat"]), group(2, ["rules"]), group(3, ["calendar"])],
                sizes: [0.5, 0.25, 0.25],
              },
              10
            ),
            NOTES
          );
          const out = dm.moveGroup(three, 3, {
            type: "edge",
            group: 1,
            edge: "left",
          });
          // Detaching renormalises the survivors (2/3 and 1/3), and
          // the halved landing share makes it even thirds.
          return (
            out.root.type === "split" &&
            out.root.children.length === 3 &&
            out.root.children.every((c) => c.type === "group") &&
            out.root.children[0].id === 3 &&
            out.root.sizes.every((s) => Math.abs(s - 1 / 3) < 1e-9)
          );
        })()
      );

      // The canvas edge: a full-length dock at DOCK_FRAC, everything
      // already there scaled into the rest.
      {
        const docked = dm.moveGroup(start, 2, { type: "root", edge: "bottom" });
        check(
          "a canvas-edge drop docks the full length of that side",
          docked.root.type === "split" &&
            docked.root.dir === "col" &&
            docked.root.children[1].id === 2 &&
            Math.abs(docked.root.sizes[1] - dm.DOCK_FRAC) < 1e-9 &&
            Math.abs(docked.root.sizes[0] - (1 - dm.DOCK_FRAC)) < 1e-9
        );
        const again = dm.moveTab(docked, 2, 0, { type: "root", edge: "top" });
        check(
          "a root split already running that way takes the newcomer as a child",
          again.root.type === "split" &&
            again.root.dir === "col" &&
            again.root.children.length === 3 &&
            Math.abs(again.root.sizes[0] - dm.DOCK_FRAC) < 1e-9 &&
            Math.abs(again.root.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9
        );
      }

      // Moving the ONLY tab of a window is moving the window: the
      // emptied frame must not survive as a hole in the tiling.
      check(
        "no window outlives its last tab, wherever the tab went",
        (() => {
          const out = dm.moveTab(start, 1, 0, {
            type: "edge",
            group: 2,
            edge: "top",
          });
          return dm.allGroups(out.root).every((g) => g.tabs.length > 0);
        })()
      );

      // Closing: the last tab takes its window with it, the space goes
      // to the neighbours, and closing everything empties the screen.
      {
        const one = dm.closeTab(start, 2, 0);
        const gone = dm.closeTab(one, 2, 0);
        check(
          "closing one tab of a stack keeps the stack",
          one.root.type === "split" &&
            dm.findGroup(one.root, 2).tabs.length === 1
        );
        check(
          "closing a window's last tab hands its space to the neighbour",
          gone.root.type === "group" && gone.root.id === 1
        );
        check(
          "closing the last window leaves an empty screen, not a crash",
          dm.closeTab(gone, 1, 0).root === null
        );
      }

      // Adding: the new window stacks into the focused group, and an
      // empty screen grows its first window whole.
      {
        const added = dm.addTab(start, { kind: "chat" });
        const home = dm.findGroup(added.root, start.focused);
        check(
          "a new window lands in the focused group, on top",
          home.tabs[home.tabs.length - 1].kind === "chat" &&
            home.active === home.tabs.length - 1
        );
        const empty = dm.closeTab(
          dm.closeTab(dm.closeTab(start, 2, 1), 2, 0),
          1,
          0
        );
        const first = dm.addTab(empty, { kind: "rules" });
        check(
          "the first window on an empty screen takes the whole screen",
          first.root !== null &&
            first.root.type === "group" &&
            first.root.tabs[0].kind === "rules"
        );
      }

      // The divider: both neighbours re-divide the span they share —
      // one grows by exactly what the other gives up — and neither
      // may pass the minimum.
      {
        const wider = dm.resizeSplit(start, 3, 0, 0.1, 0.05);
        check(
          "a divider drag moves exactly the pair astride it",
          Math.abs(wider.root.sizes[0] - 0.6) < 1e-9 &&
            Math.abs(wider.root.sizes[1] - 0.4) < 1e-9
        );
        const floored = dm.resizeSplit(start, 3, 0, -10, 0.05);
        check(
          "the minimum share holds against any pull",
          Math.abs(floored.root.sizes[0] - 0.05) < 1e-9 &&
            Math.abs(floored.root.sizes[1] - 0.95) < 1e-9
        );
        check(
          "a divider that does not exist moves nothing",
          dm.resizeSplit(start, 3, 5, 0.1, 0.05) === start
        );
      }

      // Maximize: one window covers the whole canvas while the tree
      // waits underneath UNTOUCHED — which is what makes shrink land
      // on the exact arrangement rather than a remembered copy.
      {
        const maxed = dm.toggleMaximized(start, 2);
        check(
          "maximizing covers the arrangement without touching it",
          maxed.maximized === 2 &&
            JSON.stringify(maxed.root) === JSON.stringify(start.root)
        );
        check(
          "the same press shrinks back to exactly what was there",
          dm.toggleMaximized(maxed, 2).maximized === null
        );
        check(
          "a maximized layout survives the round trip through storage",
          JSON.stringify(dm.parseLayout(dm.serializeLayout(maxed), NOTES)) ===
            JSON.stringify(maxed)
        );
        check(
          "a stored maximized id pointing at nothing is let go, not fatal",
          (() => {
            const out = dm.parseLayout(
              JSON.stringify({ ...start, maximized: 99 }),
              NOTES
            );
            return out !== null && out.maximized === null;
          })()
        );
        check(
          "no drop zones exist while a window covers the canvas",
          dm.dropTargetAt(maxed, { x: 650, y: 400 }, VIEW, 34) === null
        );
        check(
          "the cover lifts when the maximized window closes its last tab",
          (() => {
            const m = dm.toggleMaximized(start, 1);
            const out = dm.closeTab(m, 1, 0);
            return out.maximized === null && out.root.type === "group";
          })()
        );
        check(
          "maximizing a window that does not exist is refused",
          dm.toggleMaximized(start, 99) === start
        );
      }

      // The law of the screen, held across a working session: windows
      // always fill the canvas edge to edge — no overlap, no visible
      // background. Overlap is unrepresentable in the tree, but the
      // ARITHMETIC could still break it, so it is asserted on the
      // rectangles that reach the screen.
      check(
        "after a session of drops the tiling still fills the screen without overlap",
        (() => {
          let l = start;
          l = dm.addTab(l, { kind: "chat" });
          l = dm.moveTab(l, 2, 2, { type: "edge", group: 1, edge: "bottom" });
          l = dm.moveGroup(l, 2, { type: "root", edge: "left" });
          l = dm.addTab(l, { kind: "rules" });
          l = dm.moveTab(l, 2, 1, { type: "edge", group: 1, edge: "right" });
          l = dm.closeTab(l, 1, 0);
          const rects = [...dm.layoutRects(l, VIEW).values()];
          const inBounds = rects.every(
            (r) =>
              r.x >= -0.01 && r.y >= -0.01 &&
              r.x + r.w <= VIEW.w + 0.01 && r.y + r.h <= VIEW.h + 0.01
          );
          const overlap = rects.some((a, i) =>
            rects.some(
              (b, j) =>
                i < j &&
                a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 &&
                a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01
            )
          );
          const area = rects.reduce((sum, r) => sum + r.w * r.h, 0);
          return (
            rects.length >= 3 &&
            inBounds &&
            !overlap &&
            area > VIEW.w * VIEW.h * 0.9
          );
        })()
      );

      // Every kind in the menu has a name to show on its tab.
      check(
        "every panel kind has a title",
        dm.DM_PANEL_KINDS.every(
          (k) => typeof dm.DM_PANEL_TITLES[k] === "string" && dm.DM_PANEL_TITLES[k]
        )
      );
    }


    // ---- table paging ----------------------------------------------
    // Every table pages by one setting. The edges here all fail as
    // quiet nonsense on screen: a stored size the options never
    // offered, an empty table with zero pages, a filter that shrinks
    // the list under the page you were reading.
    {
      const pg = await import(
        pathToFileURL(join(compile("components/pagerModel.ts"), "pagerModel.js")).href
      );
      check(
        "a stored size outside the offered set becomes the default",
        pg.clampPageSize(30) === 30 &&
          pg.clampPageSize(25) === pg.DEFAULT_PAGE_SIZE &&
          pg.clampPageSize(undefined) === pg.DEFAULT_PAGE_SIZE &&
          pg.clampPageSize("20") === pg.DEFAULT_PAGE_SIZE
      );
      check(
        "an empty table is one page, never zero",
        pg.pageCount(0, 20) === 1 &&
          pg.pageCount(100, 20) === 5 &&
          pg.pageCount(101, 20) === 6
      );
      check(
        "a page beyond the list lands on the last page, not the first",
        (() => {
          const rows = Array.from({ length: 90 }, (_, i) => i);
          const s = pg.pageSlice(rows, 99, 20);
          return (
            s.length === 10 &&
            s[0] === 80 &&
            pg.pageSlice(rows, 2, 20)[0] === 40 &&
            pg.pageSlice([], 0, 20).length === 0
          );
        })()
      );
      check(
        "the page row keeps first, last, and the current neighbourhood",
        (() => {
          const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
          return (
            eq(pg.pageNumbers(0, 5), [0, 1, 2, 3, 4]) &&
            eq(pg.pageNumbers(0, 20), [0, 1, 2, 3, "gap", 19]) &&
            eq(pg.pageNumbers(9, 20), [0, "gap", 8, 9, 10, "gap", 19]) &&
            eq(pg.pageNumbers(19, 20), [0, "gap", 16, 17, 18, 19])
          );
        })()
      );
    }

    // ---- the GM's prep list ----------------------------------------
    // Two halves, both of which fail silently. A reorder that puts an
    // item back where it started reads as a missed click; a due date
    // off by one calls tomorrow overdue, and a list that cries wolf is
    // a list you stop believing.
    {
      const td = await import(
        pathToFileURL(join(compile("components/todoModel.ts"), "todoModel.js"))
          .href
      );

      check(
        "a new item lands past the ends of the list",
        td.orderAfter(3000) === 4000 &&
          td.orderBefore(1000) === 0 &&
          td.orderAfter(undefined) === td.ORDER_GAP &&
          td.orderBefore(undefined) === td.ORDER_GAP
      );
      // Dropping at the very top or bottom is the same question with
      // one side missing, which is why orderBetween takes undefined.
      check(
        "a key between two others sits between them",
        td.orderBetween(1000, 2000) === 1500 &&
          td.orderBetween(undefined, 1000) === 0 &&
          td.orderBetween(2000, undefined) === 3000 &&
          td.orderBetween(undefined, undefined) === td.ORDER_GAP
      );

      // Repeated inserts into one gap halve it every time. The floor
      // is what stops two items ending up with keys too close to
      // separate — after which they sort however the database feels
      // and shuffle themselves when nobody is looking.
      check(
        "splitting the same gap forever eventually asks for a renumber",
        (() => {
          let lo = 1000;
          const hi = 2000;
          for (let i = 0; i < 40; i++) {
            if (td.needsRenumber(lo, hi)) return true;
            lo = td.orderBetween(lo, hi);
          }
          return false;
        })()
      );
      check(
        "a comfortable gap does not ask for one, and an open end never does",
        !td.needsRenumber(1000, 2000) &&
          !td.needsRenumber(undefined, 1000) &&
          !td.needsRenumber(1000, undefined)
      );
      check(
        "a renumber spaces the list evenly and keeps its order",
        (() => {
          const out = td.renumber([
            { _id: "a", order: 1 },
            { _id: "b", order: 1.0001 },
            { _id: "c", order: 9 },
          ]);
          return (
            out.map((i) => i._id).join("") === "abc" &&
            out[0].order === 1000 &&
            out[2].order === 3000
          );
        })()
      );

      // Moving one item must write ONE row. Rewriting the list on every
      // drag is invisible until it is a hundred writes on a free tier.
      check(
        "a move writes only the item that moved",
        (() => {
          const items = [
            { _id: "a", order: 1000 },
            { _id: "b", order: 2000 },
            { _id: "c", order: 3000 },
          ];
          const moves = td.reorderTo(items, "c", 0);
          return moves.length === 1 && moves[0]._id === "c" && moves[0].order < 1000;
        })()
      );
      check(
        "a move lands where it was dropped, in both directions",
        (() => {
          const items = [
            { _id: "a", order: 1000 },
            { _id: "b", order: 2000 },
            { _id: "c", order: 3000 },
          ];
          const after = (moves) => {
            const by = new Map(moves.map((m) => [m._id, m.order]));
            return items
              .map((i) => ({ ...i, order: by.get(i._id) ?? i.order }))
              .sort((x, y) => x.order - y.order)
              .map((i) => i._id)
              .join("");
          };
          return (
            after(td.reorderTo(items, "a", 2)) === "bca" &&
            after(td.reorderTo(items, "c", 0)) === "cab" &&
            after(td.reorderTo(items, "a", 1)) === "bac"
          );
        })()
      );
      check(
        "a move that changes nothing writes nothing",
        (() => {
          const items = [
            { _id: "a", order: 1000 },
            { _id: "b", order: 2000 },
          ];
          return (
            td.reorderTo(items, "a", 0).length === 0 &&
            td.reorderTo(items, "ghost", 1).length === 0
          );
        })()
      );
      // The rare case: no room left, so the whole list is rewritten
      // once rather than two items being given the same key.
      check(
        "a move into an exhausted gap renumbers the list instead",
        (() => {
          const items = [
            { _id: "a", order: 1000 },
            { _id: "b", order: 1000.0001 },
            { _id: "c", order: 3000 },
          ];
          const moves = td.reorderTo(items, "c", 1);
          const orders = moves.map((m) => m.order);
          return (
            moves.length === 3 &&
            new Set(orders).size === 3 &&
            moves[1]._id === "c"
          );
        })()
      );

      check(
        "open items keep their order and finished ones sink, newest first",
        (() => {
          const out = td.sortTodos([
            { _id: "old", order: 1, done: true, doneAt: 100 },
            { _id: "second", order: 2000, done: false },
            { _id: "first", order: 1000, done: false },
            { _id: "new", order: 0, done: true, doneAt: 900 },
          ]);
          return out.map((i) => i._id).join(",") === "first,second,new,old";
        })()
      );
      check(
        "a finished item with no timestamp still sorts, at the bottom",
        (() => {
          const out = td.sortTodos([
            { _id: "x", order: 1, done: true, doneAt: null },
            { _id: "y", order: 2, done: true, doneAt: 5 },
          ]);
          return out.map((i) => i._id).join(",") === "y,x";
        })()
      );

      // Dates are compared as STRINGS. "YYYY-MM-DD" sorts
      // lexicographically in date order, so this needs no Date and
      // therefore has no timezone — which is the bug being avoided:
      // parsing into a Date makes a task overdue an evening early for
      // everyone west of UTC, and this table plays at night.
      check(
        "a due date reads against the day, not the hour",
        td.dueState("2026-08-28", "2026-08-29") === "overdue" &&
          td.dueState("2026-08-29", "2026-08-29") === "today" &&
          td.dueState("2026-09-02", "2026-08-29") === "soon" &&
          td.dueState("2026-09-30", "2026-08-29") === "later"
      );
      check(
        "the edge of the week is inside it, and the next day is not",
        td.dueState("2026-09-05", "2026-08-29") === "soon" &&
          td.dueState("2026-09-06", "2026-08-29") === "later"
      );
      check(
        "no date, or a nonsense one, has no state at all",
        td.dueState(null, "2026-08-29") === null &&
          td.dueState(undefined, "2026-08-29") === null &&
          td.dueState("", "2026-08-29") === null &&
          td.dueState("soon", "2026-08-29") === null &&
          td.dueState("2026-08-29", "rubbish") === null
      );

      check(
        "a date has to be a real day, not merely the right shape",
        td.isDate("2026-02-28") &&
          td.isDate("2028-02-29") &&
          !td.isDate("2026-02-29") &&
          !td.isDate("2026-02-30") &&
          !td.isDate("2026-13-01") &&
          !td.isDate("2026-00-10") &&
          !td.isDate("2026-8-9") &&
          !td.isDate("")
      );
      check(
        "adding days crosses months, years and a leap day",
        td.addDays("2026-08-29", 7) === "2026-09-05" &&
          td.addDays("2026-12-30", 3) === "2027-01-02" &&
          td.addDays("2028-02-28", 1) === "2028-02-29" &&
          td.addDays("2026-09-05", -7) === "2026-08-29"
      );
      // ---- links back to where an item came from ----
      // These arrive from other TOOLS rather than from a person
      // typing, which is exactly why they are cleaned: a tool with a
      // bug writes "javascript:" into a field as readily as a person
      // does, and "it came from our own code" is not a check.
      {
        const ok = td.normalizeLinks([
          { tool: "sessions", label: "Session 54", href: "/campaign/x/sessions" },
        ]);
        check(
          "a good link survives intact",
          ok.length === 1 &&
            ok[0].tool === "sessions" &&
            ok[0].label === "Session 54" &&
            ok[0].href === "/campaign/x/sessions"
        );
      }
      check(
        "anything that is not an internal link is dropped",
        td.normalizeLinks([
          { tool: "x", label: "js", href: "javascript:alert(1)" },
          { tool: "x", label: "off-site", href: "https://example.com/a" },
          { tool: "x", label: "protocol-relative", href: "//example.com/a" },
          { tool: "x", label: "relative", href: "sessions" },
          { tool: "x", label: "spaced", href: "/a b" },
          { tool: "x", label: "quoted", href: "/a\"b" },
        ]).length === 0
      );
      check(
        "a link with no words is dropped, because a chip needs a handle",
        td.normalizeLinks([
          { tool: "sessions", label: "   ", href: "/campaign/x/sessions" },
          { tool: "sessions", href: "/campaign/x/other" },
        ]).length === 0
      );
      // Tagging the same sentence twice happens, and two identical
      // chips are not information.
      check(
        "the same address only appears once",
        td.normalizeLinks([
          { tool: "sessions", label: "Session 54", href: "/a" },
          { tool: "sessions", label: "Session 54 again", href: "/a" },
          { tool: "npcs", label: "Kelja", href: "/b" },
        ]).length === 2
      );
      check(
        "an item cannot become a hub of links",
        (() => {
          const many = Array.from({ length: 30 }, (_, i) => ({
            tool: "npcs",
            label: `n${i}`,
            href: `/n/${i}`,
          }));
          return td.normalizeLinks(many).length === td.MAX_LINKS;
        })()
      );
      check(
        "a long label is cut rather than allowed to run the row",
        td.normalizeLinks([
          { tool: "x", label: "y".repeat(500), href: "/a" },
        ])[0].label.length === td.MAX_LINK_LABEL
      );
      check(
        "no links at all is an empty list, never a crash",
        td.normalizeLinks(undefined).length === 0 &&
          td.normalizeLinks([]).length === 0 &&
          td.normalizeLinks([{}]).length === 0
      );

      // ---- and again, somewhere that is not UTC ----
      //
      // This sandbox runs in UTC, which makes it exactly the wrong
      // place to test date arithmetic: every timezone bug in this
      // file is INVISIBLE here and lands on whoever is running the
      // app. Three mutations proved it — a UTC-based todayISO and a
      // local-time addDays both passed everything above.
      //
      // So the same functions run again in a child process with TZ
      // set, once behind UTC and once ahead, which is the only way
      // this machine can see a bug about where you are sitting.
      check(
        "the dates hold up outside UTC, in both directions",
        (() => {
          const dir = compile("components/todoModel.ts");
          const url = pathToFileURL(join(dir, "todoModel.js")).href;
          const script = `
            const td = await import(${JSON.stringify(url)});
            const fail = (m) => { console.log("FAIL " + m); process.exitCode = 1; };
            // 9pm on the 29th is still the 29th, wherever you are —
            // in New York the UTC date has already rolled over, and
            // in Tokyo it rolled over hours ago.
            if (td.todayISO(new Date(2026, 7, 29, 21, 30)) !== "2026-08-29") {
              fail("todayISO at 21:30 in " + process.env.TZ);
            }
            if (td.todayISO(new Date(2026, 0, 1, 0, 5)) !== "2026-01-01") {
              fail("todayISO just after midnight in " + process.env.TZ);
            }
            // A week later is a week later. Built on a local Date this
            // slips a day for every zone east of Greenwich.
            if (td.addDays("2026-08-29", 7) !== "2026-09-05") {
              fail("addDays across a week in " + process.env.TZ);
            }
            if (td.addDays("2026-12-30", 3) !== "2027-01-02") {
              fail("addDays across a year in " + process.env.TZ);
            }
            if (td.dueState("2026-09-05", "2026-08-29") !== "soon") {
              fail("dueState at the week edge in " + process.env.TZ);
            }
          `;
          // One zone behind UTC and one ahead: a bug that only shows
          // in the evening and a bug that only shows in the morning
          // are different bugs, and each zone catches one of them.
          for (const tz of ["America/New_York", "Asia/Tokyo"]) {
            const r = spawnSync(
              process.execPath,
              ["--input-type=module", "-e", script],
              { env: { ...process.env, TZ: tz }, encoding: "utf8" }
            );
            if (r.status !== 0) return false;
          }
          return true;
        })()
      );
    }

    // ---- Quick Add Magic --------------------------------------------
    //
    // Vikunja's one genuinely great idea, and the piece of this tool
    // most worth testing: it reads a sentence and decides which words
    // are the task and which are its properties. Every way it is wrong
    // is silent — a task loses a word to a date it did not mean, or
    // gains a due date a week off, and neither throws.
    //
    // `today` is an ARGUMENT, so all of this is testable at any date.
    {
      const qa = await import(
        pathToFileURL(join(compile("components/quickAdd.ts"), "quickAdd.js"))
          .href
      );
      // A Saturday, chosen so the weekend and the weekday rules are
      // both exercised at an edge rather than in the middle of a week.
      const SAT = "2026-08-29";

      const parse = (line, today = SAT) => qa.parseQuickAdd(line, today);

      check(
        "the tokens come off and the task is what is left",
        (() => {
          const r = parse("statblock for the lich tomorrow *combat !4");
          return (
            r.text === "statblock for the lich" &&
            r.due === "2026-08-30" &&
            r.priority === 4 &&
            r.labels.join() === "combat"
          );
        })()
      );
      check(
        "a quoted name keeps its spaces",
        (() => {
          const r = parse("map the sewers *'boss fight' +'Between sessions'");
          return (
            r.text === "map the sewers" &&
            r.labels.join() === "boss fight" &&
            r.project === "Between sessions"
          );
        })()
      );
      // A bare token ends at the first space. Documented, and the
      // reason the field shows what it understood.
      check(
        "an unquoted project takes one word",
        parse("prep +Session prep").project === "Session"
      );
      check(
        "the same label twice is one label",
        parse("thing *prep *PREP *Prep").labels.length === 1
      );

      // ---- dates -----------------------------------------------
      const due = (line, today = SAT) => parse(line, today).due;
      check("today", due("x today") === SAT);
      check("tomorrow", due("x tomorrow") === "2026-08-30");
      check("in N days", due("x in 3 days") === "2026-09-01");
      check("in N weeks", due("x in 2 weeks") === "2026-09-12");
      check("in N months", due("x in 1 month") === "2026-09-29");
      check("next week", due("x next week") === "2026-09-05");
      check("next month", due("x next month") === "2026-09-29");
      check("end of month", due("x end of month") === "2026-08-31");
      check("an explicit date", due("x 2026-12-01") === "2026-12-01");
      check("a month and a day", due("x sep 3") === "2026-09-03");
      check("a day and a month", due("x 3 sep") === "2026-09-03");
      check("an ordinal", due("x sept 3rd") === "2026-09-03");
      // Rolling forward is the only useful reading: nobody schedules
      // prep for a date that has already gone.
      check(
        "a month already past means next year",
        due("x feb 3") === "2027-02-03"
      );
      // Strictly after. Typed on a Saturday, "saturday" is the one
      // coming — you would have typed "today" for this one.
      check("a weekday is the NEXT one", due("x saturday") === "2026-09-05");
      check("next monday", due("x next monday") === "2026-08-31");
      check("a three-letter weekday", due("x tue") === "2026-09-01");
      check("this weekend on a Saturday is today", due("x this weekend") === SAT);
      check(
        "this weekend on a Wednesday is Saturday",
        due("x this weekend", "2026-08-26") === "2026-08-29"
      );

      // The first date wins, and only the first is eaten.
      check(
        "two dates in a line leave the second as prose",
        (() => {
          const r = parse("book today for tomorrow");
          return r.due === SAT && r.text === "book for tomorrow";
        })()
      );

      // ---- what must NOT be eaten -------------------------------
      check(
        "an asterisk inside a word is not a label",
        (() => {
          const r = parse("roll 5*d6 damage");
          return r.labels.length === 0 && r.text === "roll 5*d6 damage";
        })()
      );
      check(
        "a bang that is not a priority stays in the text",
        (() => {
          const r = parse("call about !soon thing");
          return r.priority === null && r.text.includes("!soon");
        })()
      );
      check(
        "a priority outside 1-5 is not a priority",
        parse("x !9").priority === null && parse("x !0").priority === null
      );
      // A label called *friday must not become a due date. Tokens are
      // taken out BEFORE the prose is searched, which is what makes
      // this hold.
      check(
        "a date word inside a label stays a label",
        (() => {
          const r = parse("do the thing *friday");
          return r.due === null && r.labels.join() === "friday";
        })()
      );
      // Numeric day/month is ambiguous and is deliberately not read.
      // 3/9 is two different days depending on where you live, and a
      // task silently due six months late is the worst kind of wrong.
      check(
        "a slashed numeric date is left alone",
        (() => {
          const r = parse("session 3/9");
          return r.due === null && r.text === "session 3/9";
        })()
      );
      check(
        "an impossible explicit date is not a date",
        parse("x 2026-02-30").due === null
      );
      // And the same through the month-name path, which is a different
      // guard: monthDay builds the string and has to reject it before
      // it ever becomes a due date.
      check(
        "an impossible month and day is left as prose",
        (() => {
          const r = parse("x feb 30");
          return r.due === null && r.text === "x feb 30";
        })()
      );
      check(
        "the 29th of February lands on a leap year",
        due("x feb 29", "2027-06-01") === "2028-02-29"
      );

      // ---- the arithmetic underneath ----------------------------
      // Clamping, not rolling over: a Date rolls the 31st of January
      // into the 3rd of March, which is a month later by nobody's
      // reckoning.
      check(
        "a month after the 31st clamps to the short month",
        qa.addMonths("2026-01-31", 1) === "2026-02-28"
      );
      check(
        "and does it in a leap year too",
        qa.addMonths("2028-01-31", 1) === "2028-02-29"
      );
      check(
        "months cross a year end",
        qa.addMonths("2026-11-30", 2) === "2027-01-30"
      );
      check("end of a 30-day month", qa.endOfMonth("2026-09-14") === "2026-09-30");
      check("end of February", qa.endOfMonth("2026-02-01") === "2026-02-28");
      check(
        "the next weekday is never today",
        qa.nextWeekday(SAT, 6) === "2026-09-05"
      );

      // And the same, outside UTC. The sandbox this runs in is UTC, so
      // a `new Date()` that slipped into the parsing path would be
      // invisible here and land on whoever is running the app —
      // exactly the failure the todoModel dates section above was
      // written for, one module along.
      check(
        "quick-add's dates hold up outside UTC, in both directions",
        (() => {
          const dir = compile("components/quickAdd.ts");
          const url = pathToFileURL(join(dir, "quickAdd.js")).href;
          const script = `
            const qa = await import(${JSON.stringify(url)});
            const fail = (m) => { console.log("FAIL " + m); process.exitCode = 1; };
            const at = (l) => qa.parseQuickAdd(l, "2026-08-29").due;
            if (at("x tomorrow") !== "2026-08-30") fail("tomorrow in " + process.env.TZ);
            if (at("x next week") !== "2026-09-05") fail("next week in " + process.env.TZ);
            if (at("x tue") !== "2026-09-01") fail("weekday in " + process.env.TZ);
            if (at("x sep 3") !== "2026-09-03") fail("month day in " + process.env.TZ);
            if (at("x end of month") !== "2026-08-31") fail("end of month in " + process.env.TZ);
            if (qa.addMonths("2026-01-31", 1) !== "2026-02-28") fail("addMonths in " + process.env.TZ);
            if (qa.dayOfWeek("2026-08-29") !== 6) fail("dayOfWeek in " + process.env.TZ);
          `;
          for (const tz of ["America/New_York", "Asia/Tokyo"]) {
            const r = spawnSync(
              process.execPath,
              ["--input-type=module", "-e", script],
              { env: { ...process.env, TZ: tz }, encoding: "utf8" }
            );
            if (r.status !== 0) return false;
          }
          return true;
        })()
      );
    }

    // ---- the To-Do palette and priority ------------------------------
    // What is stored is a palette ID and what is drawn is a colour, and
    // the crossing has to be a lookup that cannot fail open.
    {
      const td = await import(
        pathToFileURL(join(compile("components/todoModel.ts"), "todoModel.js"))
          .href
      );
      check(
        "a known id is its colour",
        td.colorOf("amber") === td.TODO_COLORS.amber
      );
      // Never returns what it was given, and never throws: a row
      // written before a colour left the palette must render as
      // something rather than putting an unknown string into a style.
      for (const bad of [
        "javascript:alert(1)",
        "red; background:url(x)",
        "",
        null,
        undefined,
        "toString",
        "__proto__",
      ]) {
        check(
          `an unusable colour id (${JSON.stringify(bad)}) falls back`,
          td.colorOf(bad) === td.TODO_COLORS[td.DEFAULT_COLOR] &&
            !td.isColorId(bad)
        );
      }
      check("every palette id is one", td.TODO_COLOR_IDS.every(td.isColorId));

      check(
        "a priority outside the scale is unset",
        td.cleanPriority(0) === undefined &&
          td.cleanPriority(6) === undefined &&
          td.cleanPriority("x") === undefined &&
          td.cleanPriority(null) === undefined
      );
      check("and inside it is itself", td.cleanPriority(3) === 3);
      check("a decimal rounds into the scale", td.cleanPriority(3.4) === 3);
      // Vikunja's rule: only High and above is drawn. A list where
      // every row wears a badge has told you nothing.
      check(
        "only high and above shows",
        !td.showsPriority(2) &&
          td.showsPriority(3) &&
          td.showsPriority(5) &&
          !td.showsPriority(null) &&
          !td.showsPriority(undefined)
      );
      check(
        "a name matches past case and spacing",
        td.nameKey("  Boss   Fight ") === td.nameKey("boss fight")
      );

      // ---- how far off a due date is, in words ---------------------
      // Vikunja's phrasing, and the reason for it: "Overdue" is the
      // same word for yesterday and for March, and the second one
      // wants noticing more.
      const T = "2026-08-29";
      const rel = (due) => td.relativeDue(due, T);
      check("today", rel(T) === "Due today");
      check("tomorrow", rel("2026-08-30") === "Due tomorrow");
      check("yesterday", rel("2026-08-28") === "Due yesterday");
      check("a few days out", rel("2026-09-02") === "Due in 4 days");
      check("a few days late", rel("2026-08-25") === "Due 4 days ago");
      // Days stop being readable somewhere; nobody counts "in 47 days".
      check("a fortnight becomes weeks", rel("2026-09-12") === "Due in 2 weeks");
      check("and so does one behind", rel("2026-08-15") === "Due 2 weeks ago");
      check("far enough out becomes months", rel("2026-12-01") === "Due in 3 months");
      check(
        "nothing to say about no date",
        rel(null) === null && rel(undefined) === null && rel("nope") === null
      );

      // The arithmetic underneath. Built at UTC midnight on both ends,
      // so a daylight-saving hour cannot make a day count come out at
      // 1.958 and floor to the wrong answer twice a year.
      check(
        "days across a month end",
        td.daysBetween("2026-08-29", "2026-09-02") === 4
      );
      check(
        "days across a year end",
        td.daysBetween("2026-12-30", "2027-01-02") === 3
      );
      check("backwards is negative", td.daysBetween("2026-08-29", "2026-08-25") === -4);
      check("the same day is zero", td.daysBetween(T, T) === 0);
      // The two Sundays either side of a US daylight-saving change.
      check(
        "days across a clock change",
        td.daysBetween("2026-03-07", "2026-03-09") === 2 &&
          td.daysBetween("2026-10-31", "2026-11-02") === 2
      );

      // And outside UTC, which the sandbox cannot see on its own.
      check(
        "the relative dates hold up outside UTC, in both directions",
        (() => {
          const dir = compile("components/todoModel.ts");
          const url = pathToFileURL(join(dir, "todoModel.js")).href;
          const script = `
            const td = await import(${JSON.stringify(url)});
            const fail = (m) => { console.log("FAIL " + m); process.exitCode = 1; };
            const T = "2026-08-29";
            if (td.relativeDue(T, T) !== "Due today") fail("today in " + process.env.TZ);
            if (td.relativeDue("2026-08-30", T) !== "Due tomorrow") fail("tomorrow in " + process.env.TZ);
            if (td.relativeDue("2026-08-25", T) !== "Due 4 days ago") fail("late in " + process.env.TZ);
            if (td.daysBetween("2026-03-07", "2026-03-09") !== 2) fail("clock change in " + process.env.TZ);
            if (td.daysBetween("2026-12-30", "2027-01-02") !== 3) fail("year end in " + process.env.TZ);
          `;
          for (const tz of ["America/New_York", "Asia/Tokyo"]) {
            const r = spawnSync(
              process.execPath,
              ["--input-type=module", "-e", script],
              { env: { ...process.env, TZ: tz }, encoding: "utf8" }
            );
            if (r.status !== 0) return false;
          }
          return true;
        })()
      );
      check(
        "but not past a real difference",
        td.nameKey("NPCs") !== td.nameKey("NPC")
      );
    }

    // ---- dice notation ---------------------------------------------
    // A dice roller fails quietly by definition: nobody at the table
    // can tell a keep-highest that kept the lowest, a modifier that
    // was dropped, or a d100 that can come up 0, from bad luck. The
    // random source is injected so every one of those is decidable
    // here rather than after somebody rolls a character.
    {
      const dice = await import(
        pathToFileURL(join(compile("components/diceModel.ts"), "diceModel.js"))
          .href
      );
      /** A fixed sequence, looping. Feeds exact faces to the roller. */
      const seq = (...fracs) => {
        let i = 0;
        return () => fracs[i++ % fracs.length];
      };
      /** Faces 1..sides, as the fractions that produce them. */
      const face = (n, sides) => (n - 1) / sides + 1 / (sides * 2);

      check(
        "a bare d20 is one die, not zero",
        (() => {
          const p = dice.parseRoll("d20");
          return (
            p?.terms.length === 1 &&
            p.terms[0].kind === "dice" &&
            p.terms[0].count === 1 &&
            p.terms[0].sides === 20
          );
        })()
      );

      // The one that is invisible when wrong. 4d6kh3 on faces
      // 2,5,3,6 must drop the 2 — keeping the LOWEST three is the
      // same arithmetic shape and gives stats nobody questions.
      check(
        "keep-highest drops the lowest die and only that one",
        (() => {
          const r = dice.roll(
            "4d6kh3",
            seq(face(2, 6), face(5, 6), face(3, 6), face(6, 6))
          );
          const d = dice.allDice(r);
          return (
            r.total === 14 &&
            d.length === 4 &&
            d.map((x) => x.value).join() === "2,5,3,6" &&
            d.filter((x) => !x.kept).map((x) => x.value).join() === "2"
          );
        })()
      );
      check(
        "keep-lowest is disadvantage, not advantage under another name",
        (() => {
          const adv = dice.roll("2d20kh1", seq(face(4, 20), face(17, 20)));
          const dis = dice.roll("2d20kl1", seq(face(4, 20), face(17, 20)));
          return adv.total === 17 && dis.total === 4;
        })()
      );
      // The dropped die stays in the record. Half the pleasure of a
      // stat roll is seeing the 2 you threw away, and the log renders
      // what is here.
      check(
        "a dropped die is kept in the result, just not in the total",
        dice.allDice(dice.roll("2d20kh1", seq(face(4, 20), face(17, 20))))
          .length === 2
      );

      check(
        "a negative term subtracts, and terms add up in order",
        (() => {
          const r = dice.roll("1d8+1d6-2", seq(face(5, 8), face(4, 6)));
          return r.total === 7 && r.terms.length === 3;
        })()
      );
      check(
        "the sign belongs to the dice, not just to flat numbers",
        dice.roll("1d8-1d6", seq(face(5, 8), face(4, 6))).total === 1
      );

      // The classic off-by-one at both ends of the random source. A
      // d100 that can roll 0 or 101 is a bug nobody reports, because
      // one roll in a hundred looks like a bad memory.
      check(
        "no die ever lands off its own faces",
        (() => {
          for (const sides of dice.STANDARD_DICE) {
            const lo = dice.roll(`1d${sides}`, () => 0);
            const hi = dice.roll(`1d${sides}`, () => 0.999999999);
            if (lo.total !== 1 || hi.total !== sides) return false;
          }
          // And a source that misbehaves outright is clamped rather
          // than trusted: 1.0 is outside [0, 1) but arrives anyway.
          return (
            dice.roll("1d20", () => 1).total === 20 &&
            dice.roll("1d20", () => -1).total === 1
          );
        })()
      );
      // The two checks above only sample: the ends of the range and
      // the middle of each face. This walks EVERY face of every die
      // and lands just inside both ends of its share of [0, 1), which
      // is where a shifted or squeezed range shows up — a d100 whose
      // top face needs a fraction the source cannot produce is a die
      // that never rolls 100 and never explains why.
      //
      // Just inside, not exactly on the boundary: n/sides * sides is
      // 28.999999999999996 for 29/100, so an exact edge tests the
      // float unit rather than the arithmetic.
      check(
        "every face owns an equal share of the range, end to end",
        (() => {
          for (const sides of [4, 6, 20, 100]) {
            for (let n = 0; n < sides; n++) {
              const lo = dice.roll(`1d${sides}`, () => (n + 0.001) / sides);
              const hi = dice.roll(`1d${sides}`, () => (n + 0.999) / sides);
              if (lo.total !== n + 1 || hi.total !== n + 1) return false;
            }
          }
          return true;
        })()
      );

      // Every one of these is a typo somebody will make in the box.
      // They must come back as null — a thrown error here is an
      // unhandled rejection in a keystroke handler.
      check(
        "nonsense is null rather than a throw or a silent zero",
        [
          "",
          "   ",
          "d",
          "d0",
          "d1",
          "0d6",
          "2d6 3",
          "2d6+",
          "2d6++3",
          "4d6kh5",
          "4d6kh0",
          "2d6 apples",
          "abc",
          "-",
          "1d2000",
          "200d6",
          "1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6+1d6",
        ].every((s) => dice.parseRoll(s) === null)
      );
      check(
        "the things a person actually types all parse",
        ["d20", "2d6+3", "4d6kh3", "2d20kl1", "1d8+1d6-2", "10", "3D6 + 2"]
          .every((s) => dice.parseRoll(s) !== null)
      );

      // What is stored is the normalised string, so it has to parse
      // back to the same terms. Otherwise re-rolling a logged roll
      // quietly rolls something else.
      check(
        "the stored notation re-parses to the roll it came from",
        ["d20", " 3D6 + 2 ", "4d6kh3", "1d8+1d6-2", "2d20kl1"].every((s) => {
          const once = dice.parseRoll(s);
          const twice = dice.parseRoll(once.notation);
          return (
            twice !== null &&
            twice.notation === once.notation &&
            JSON.stringify(twice.terms) === JSON.stringify(once.terms)
          );
        })
      );
      check(
        "a bare d20 is written back as 1d20",
        dice.parseRoll("d20").notation === "1d20" &&
          dice.parseRoll("2d6 + 3").notation === "2d6+3" &&
          dice.parseRoll("1d8 - 2").notation === "1d8-2"
      );

      // The crit is what the table reacts to, and it is only a crit
      // when there is exactly one d20 scoring. A dropped nat 20 on
      // disadvantage is not a crit, and announcing it as one is worse
      // than saying nothing.
      check(
        "a crit needs one scoring d20 and nothing else",
        (() => {
          const nat20 = dice.roll("1d20+5", () => face(20, 20));
          const nat1 = dice.roll("1d20", () => face(1, 20));
          const dropped = dice.roll(
            "2d20kl1",
            seq(face(20, 20), face(9, 20))
          );
          const two = dice.roll("2d20", seq(face(20, 20), face(9, 20)));
          const notAd20 = dice.roll("1d12", () => face(12, 12));
          return (
            dice.critOf(nat20) === "high" &&
            dice.critOf(nat1) === "low" &&
            dice.critOf(dropped) === null &&
            dice.critOf(two) === null &&
            dice.critOf(notAd20) === null
          );
        })()
      );
      // Advantage that comes up 20 IS a crit: the 20 is the die that
      // scored, and the other one was never in play.
      check(
        "advantage keeping a natural 20 still crits",
        dice.critOf(dice.roll("2d20kh1", seq(face(20, 20), face(9, 20)))) ===
          "high"
      );

      // The ceilings are what stop one pasted string costing the whole
      // table a re-send of ten thousand dice.
      check(
        "the caps hold across terms, not just within one",
        dice.parseRoll(`${dice.MAX_DICE}d6`) !== null &&
          dice.parseRoll(`${dice.MAX_DICE + 1}d6`) === null &&
          dice.parseRoll(`${dice.MAX_DICE}d6+1d6`) === null
      );
      check(
        "a flat term cannot be arbitrarily large either",
        dice.parseRoll(`1d6+${dice.MAX_FLAT}`) !== null &&
          dice.parseRoll(`1d6+${dice.MAX_FLAT + 1}`) === null
      );

      // ---- the pool builder ----
      // The tray writes to the same notation string you can type in,
      // so every one of these is a way the two could silently
      // disagree about what is in your hand.
      check(
        "clicking a die adds one of it, and merges with its own kind",
        dice.addDie("", 6) === "1d6" &&
          dice.addDie("1d6", 6) === "2d6" &&
          dice.addDie("8d6", 6) === "9d6" &&
          dice.addDie("8d6", 4) === "8d6+1d4" &&
          dice.addDie("8d6+4d4", 4) === "8d6+5d4"
      );
      // Merging into a kept term would change what the keep means:
      // "4d6kh3" plus a d6 is not "5d6kh3", it is a different roll.
      check(
        "a die added to a kept term becomes its own term",
        dice.addDie("4d6kh3", 6) === "4d6kh3+1d6"
      );
      // Dice before the modifier, so the pool reads the way people
      // write it rather than 8d6+3+4d4.
      check(
        "a new die goes in front of the modifier, not after it",
        dice.addDie("8d6+3", 4) === "8d6+1d4+3"
      );
      check(
        "the ceilings hold, and refuse rather than clamp",
        dice.addDie(`${dice.MAX_DICE}d6`, 6) === `${dice.MAX_DICE}d6` &&
          dice.addDie(`${dice.MAX_DICE - 1}d6`, 4) === `${dice.MAX_DICE - 1}d6+1d4`
      );
      // Not a die at all is refused. An odd-but-real die is not: the
      // TRAY only offers the standard seven, but the notation has
      // always accepted anything with two or more faces, and addDie
      // must not be the thing that quietly narrows that.
      check(
        "a size that is not a die is refused, an unusual one is not",
        dice.addDie("2d6", 0) === "2d6" &&
          dice.addDie("2d6", 1) === "2d6" &&
          dice.addDie("2d6", dice.MAX_SIDES + 1) === "2d6" &&
          dice.addDie("2d6", 2.5) === "2d6" &&
          dice.addDie("2d6", 7) === "2d6+1d7"
      );
      // A half-typed box is somebody mid-thought, not an error.
      check(
        "clicking a die on unreadable text leaves the text alone",
        dice.addDie("2d6+", 6) === "2d6+" && dice.addDie("gibberish", 6) === "gibberish"
      );

      check(
        "the modifier collapses to one term and can go negative",
        dice.adjustFlat("2d6", 3) === "2d6+3" &&
          dice.adjustFlat("2d6+3", 2) === "2d6+5" &&
          dice.adjustFlat("2d6+3", -5) === "2d6-2" &&
          dice.adjustFlat("2d6-2", -1) === "2d6-3"
      );
      // "+0" is a modifier that looks like it is doing something.
      check(
        "a modifier nudged back to zero disappears",
        dice.adjustFlat("2d6+3", -3) === "2d6" &&
          dice.adjustFlat("2d6-1", 1) === "2d6"
      );
      check(
        "the modifier alone is a roll, and emptying it empties the pool",
        dice.adjustFlat("", 3) === "3" && dice.adjustFlat("3", -3) === ""
      );
      check(
        "the flat total is readable back out of a notation",
        dice.flatOf("8d6+4d4+3") === 3 &&
          dice.flatOf("1d20-2") === -2 &&
          dice.flatOf("8d6") === 0 &&
          dice.flatOf("nonsense") === 0
      );
      // Switching to Advantage must not eat the +5 you just set.
      check(
        "swapping the dice keeps the modifier",
        dice.adjustFlat("2d20kh1", dice.flatOf("1d20+5")) === "2d20kh1+5"
      );

      // ---- reading a mixed roll back ----
      // "8d6+4d4" is twelve faces in one list, and the grouping is
      // the only thing that says which four were the d4s.
      check(
        "the faces group by the term that threw them",
        (() => {
          const r = dice.roll("2d6+3d4", seq(face(5, 6), face(2, 6), face(1, 4), face(4, 4), face(3, 4)));
          const g = dice.groupDice(dice.allDice(r));
          return (
            g.length === 2 &&
            g[0].label === "2d6" &&
            g[0].subtotal === 7 &&
            g[1].label === "3d4" &&
            g[1].subtotal === 8
          );
        })()
      );
      // Two terms of the SAME die stay two groups — they differ by
      // their keep, and merging them would show one handful of five.
      check(
        "same-sided terms stay apart when they are different terms",
        (() => {
          const r = dice.roll("2d6+3d6", seq(face(5, 6), face(2, 6), face(1, 6), face(4, 6), face(3, 6)));
          return dice.groupDice(dice.allDice(r)).length === 2;
        })()
      );
      // A dropped die belongs to its group but not to its subtotal.
      check(
        "a group's subtotal excludes the dice the keep dropped",
        (() => {
          const r = dice.roll("4d6kh3", seq(face(2, 6), face(5, 6), face(3, 6), face(6, 6)));
          const g = dice.groupDice(dice.allDice(r));
          return g.length === 1 && g[0].dice.length === 4 && g[0].subtotal === 14;
        })()
      );
      // Rows stored before dice carried a term index: falls back to
      // runs of one size rather than to one undifferentiated row.
      check(
        "rows written before term indexes still group by die size",
        (() => {
          const old = [
            { sides: 6, value: 4, kept: true },
            { sides: 6, value: 2, kept: true },
            { sides: 4, value: 3, kept: true },
          ];
          const g = dice.groupDice(old);
          return g.length === 2 && g[0].label === "2d6" && g[1].label === "1d4";
        })()
      );
      check("no dice is no groups", dice.groupDice([]).length === 0);

      check(
        "the one-line description shows dropped dice and the total",
        dice.describe(dice.roll("2d6+3", seq(face(4, 6), face(5, 6)))) ===
          "2d6+3 → 4, 5 +3 = 12" &&
          dice
            .describe(dice.roll("2d20kh1", seq(face(4, 20), face(17, 20))))
            .includes("(4)")
      );
    }

    // ---- what dddice is asked to draw ------------------------------
    // The 3D dice are decoration, which is exactly why this needs
    // testing: our own log shows the right total whatever the canvas
    // does, so a percentile split into the wrong two dice, or a
    // dropped die drawn as a counting one, is wrong on the table and
    // right on the screen beside it. Nobody would file that.
    {
      const map = await import(
        pathToFileURL(join(compile("components/dddiceMap.ts"), "dddiceMap.js"))
          .href
      );
      const die = (sides, value, kept = true) => ({ sides, value, kept });

      check(
        "an ordinary die goes over as its own mesh and face",
        (() => {
          const out = map.toDddiceRoll([die(20, 17), die(6, 4)]);
          return (
            out.length === 2 &&
            out[0].type === "d20" &&
            out[0].value === 17 &&
            out[1].type === "d6" &&
            out[1].value === 4
          );
        })()
      );
      check(
        "a dropped die is drawn, and marked as not counting",
        (() => {
          const out = map.toDddiceRoll([die(20, 18), die(20, 3, false)]);
          return (
            out.length === 2 &&
            out[0].is_dropped === undefined &&
            out[1].is_dropped === true
          );
        })()
      );

      // The percentile split. dddice has no d100 mesh — it is a tens
      // die and a units die — and both ends of the range are where a
      // reasonable-looking `v % 10` goes wrong.
      check(
        "a d100 splits into a tens and a units die that sum back",
        (() => {
          for (let v = 1; v <= 100; v++) {
            const { tens, ones } = map.splitPercentile(v);
            if (tens + ones !== v) return false;
            // The units die has faces 1-10, never 0. The tens die has
            // 0, 10 … 90, never 100.
            if (ones < 1 || ones > 10) return false;
            if (tens < 0 || tens > 90 || tens % 10 !== 0) return false;
          }
          return true;
        })()
      );
      check(
        "the awkward percentile cases land where a table would read them",
        (() => {
          const eq = (v, t, o) => {
            const s = map.splitPercentile(v);
            return s.tens === t && s.ones === o;
          };
          return eq(73, 70, 3) && eq(100, 90, 10) && eq(5, 0, 5) && eq(10, 0, 10);
        })()
      );
      check(
        "a d100 goes over as two dice, tens first, carrying its display",
        (() => {
          const out = map.toDddiceRoll([die(100, 73)]);
          return (
            out.length === 2 &&
            out[0].type === "d10x" &&
            out[0].value_to_display === 70 &&
            out[1].type === "d10" &&
            out[1].value === 3
          );
        })()
      );

      // Nothing rather than something wrong: half a fireball on the
      // table disagrees with the log, and the log is the real answer.
      check(
        "a pool past the room's limit is not drawn at all",
        (() => {
          const many = Array.from({ length: 26 }, () => die(6, 3));
          return (
            map.toDddiceRoll(many) === null &&
            map.toDddiceRoll(many.slice(0, 25)).length === 25
          );
        })()
      );
      // A percentile die costs TWO against that limit, which is why
      // the count is taken after the mapping rather than before.
      check(
        "a percentile die counts as the two dice it becomes",
        map.toDddiceRoll(Array.from({ length: 13 }, () => die(100, 50))) === null
      );
      check(
        "a die dddice has no mesh for cancels the whole throw",
        map.toDddiceRoll([die(6, 3), die(7, 5)]) === null &&
          map.toDddiceRoll([]) === null
      );
      check(
        "the theme rides along on every die when one is set",
        map
          .toDddiceRoll([die(100, 42), die(6, 1)], "dddice-bees")
          .every((d) => d.theme === "dddice-bees")
      );
    }

    // ---- reading a dddice failure back ------------------------------
    // Getting this wrong is invisible in the worst way: the dice keep
    // working and only the DIAGNOSTIC breaks. It shipped printing a
    // rejected roll as "{}" — the SDK had handed over an object with
    // no message and no status, and the actual complaint was sitting
    // in the response body. Every round trip that costs is a round
    // trip spent asking what happened.
    {
      const err = await import(
        pathToFileURL(
          join(compile("components/dddiceError.ts"), "dddiceError.js")
        ).href
      );

      check(
        "a status is found whether it is on the error or its response",
        err.statusOf({ status: 409 }) === 409 &&
          err.statusOf({ response: { status: 422 } }) === 422 &&
          err.statusOf(new Error("nope")) === null &&
          err.statusOf(null) === null
      );
      check(
        "an ordinary Error speaks for itself",
        err.reason(new Error("Request failed")) === "Request failed"
      );
      check(
        "a message and a status are reported together",
        err.reason({ message: "Request failed", response: { status: 409 } }) ===
          "Request failed — HTTP 409"
      );
      // The one that mattered: a rejection whose complaint is only in
      // the body. This is what printed as "{}".
      check(
        "a validation body is read rather than shown as an empty object",
        (() => {
          const out = err.reason({
            response: {
              status: 422,
              data: {
                message: "The given data was invalid.",
                errors: { "dice.0.theme": ["The theme field is required."] },
              },
            },
          });
          return (
            out.includes("The given data was invalid.") &&
            out.includes("dice.0.theme") &&
            out.includes("The theme field is required.") &&
            out.includes("422")
          );
        })()
      );
      check(
        "a plain-text body is used, and not at unbounded length",
        (() => {
          const out = err.reason({ response: { status: 500, data: "x".repeat(900) } });
          return out.includes("HTTP 500") && out.length < 300;
        })()
      );
      // An SDK error class with nothing on it still has a name, and
      // "RollError" beats "no reason given" by a wide margin.
      check(
        "a nameless failure still names its own class",
        (() => {
          class RollError {}
          return err.reason(new RollError()) === "RollError";
        })()
      );
      check(
        "nothing at all still produces a sentence, never [object Object]",
        (() => {
          for (const bad of [{}, null, undefined, 0, []]) {
            const out = err.reason(bad);
            if (typeof out !== "string" || out === "" || out.includes("[object")) {
              return false;
            }
          }
          return true;
        })()
      );
      check("a string is its own reason", err.reason("boom") === "boom");
      // The body is printed VERBATIM when its shape is not one of the
      // recognised ones. Three messages in a row identified this
      // failure as "422" and nothing else, each because it assumed a
      // shape and dropped what did not fit. A reader that only
      // understands what it expects goes blind exactly when needed.
      check(
        "an unrecognised body is dumped rather than discarded",
        (() => {
          const out = err.reason({
            message: "Request failed with status code 422",
            response: { status: 422, data: { detail: "dice.0.value invalid" } },
          });
          return out.includes("dice.0.value invalid") && out.includes("422");
        })()
      );
      check(
        "the dump is bounded and skips a body with nothing in it",
        (() => {
          const big = err.reason({
            response: { status: 422, data: { junk: "y".repeat(2000) } },
          });
          const empty = err.reason({
            message: "Request failed",
            response: { status: 422, data: {} },
          });
          return (
            big.length < 400 &&
            big.includes("422") &&
            empty === "Request failed — HTTP 422"
          );
        })()
      );
    }

    // ---- the room's background art ----------------------------------
    {
      const map2 = await import(
        pathToFileURL(join(compile("components/dddiceMap.ts"), "dddiceMap.js"))
          .href
      );
      check(
        "a stored path becomes an address, however it was written",
        map2.backgroundUrl("/bg/x.webp") === "https://dddice.com/bg/x.webp" &&
          map2.backgroundUrl("bg/x.webp") === "https://dddice.com/bg/x.webp" &&
          map2.backgroundUrl("//bg/x.webp") === "https://dddice.com/bg/x.webp"
      );
      check(
        "an absolute URL is left alone",
        map2.backgroundUrl("https://cdn.dddice.com/a.webp") ===
          "https://cdn.dddice.com/a.webp"
      );
      check(
        "a room with no background asks for no image",
        map2.backgroundUrl(null) === null &&
          map2.backgroundUrl(undefined) === null &&
          map2.backgroundUrl("   ") === null
      );
    }

    // ---- the Moonbrook session import holds to its sources ----------
    // The records in scripts/import-moonbrook-sessions.mjs were merged
    // from the OneNote session pages and the Discord scheduling
    // channel. What can drift silently: an XP figure off the
    // documented ledger, a duplicate session number (the import keys
    // on numbers), a player outside the known cast, or notes HTML the
    // sanitizer would quietly eat on its way into the database.
    {
      const { MOONBROOK_SESSIONS: R } = await import(
        pathToFileURL(
          join(process.cwd(), "scripts/import-moonbrook-sessions.mjs")
        ).href
      );
      // Derek's numbering, read back out of the app after he corrected
      // it: 53 whole numbers, 1 through 53, no gaps and no halves. An
      // earlier version parked three games on .5 numbers; he folded
      // them in, and this is now the record rather than something this
      // file gets to re-derive.
      check(
        "the numbering is 1 through 56, whole numbers, in date order",
        R.length === 56 &&
          R.every((r, i) => r.number === i + 1) &&
          R.every((r) => Number.isInteger(r.number))
      );
      // Both import passes match on the date, so a record without one
      // is a record that can never be found again.
      check(
        "every session carries a date, and no two share one",
        R.every((r) => typeof r.date === "string" && r.date) &&
          new Set(R.map((r) => r.date)).size === R.length
      );
      // The one figure both sources agree on: XP tracking ran to
      // session 23 and stood at 36,200 there.
      check(
        "the XP awarded through session 23 lands on the documented 36,200",
        R.filter((r) => r.number <= 23 && r.xp !== undefined).reduce(
          (a, r) => a + r.xp,
          0
        ) === 36200
      );
      check(
        "dates are ISO and run in session order",
        (() => {
          let last = "";
          for (const r of [...R].sort((a, b) => a.number - b.number)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return false;
            if (r.date < last) return false;
            last = r.date;
          }
          return true;
        })()
      );
      check(
        "every listed player is someone who actually sat at this table",
        (() => {
          const cast = new Set([
            "Alex", "Andrew", "Caprica", "Drew", "Gaige",
            "Hank", "Julie", "Max", "Scott", "Steph",
          ]);
          return R.every((r) => r.players.every((p) => cast.has(p)));
        })()
      );
      // The GM notes are inserted through sanitizeBoxHtml. Canonical
      // HTML passes through IDENTICALLY — so any drift here means the
      // sanitizer would silently rewrite or drop note content the
      // moment it was imported.
      {
        const bx = await import(
          pathToFileURL(
            join(compile("components/boxHtml.ts"), "boxHtml.js")
          ).href
        );
        const changed = R.filter(
          (r) => r.dmNotes && bx.sanitizeBoxHtml(r.dmNotes) !== r.dmNotes
        );
        check(
          "every session's GM notes survive the sanitizer untouched",
          R.filter((r) => r.dmNotes).length === 42 && changed.length === 0
        );
      }

      // A description says what happened IN THE GAME. Attendance,
      // start times and where a date came from are facts about the
      // evening, not about Moonbrook — the columns beside it carry the
      // ones worth keeping, and the GM notes carry the provenance. The
      // giveaway is a PLAYER's name: these summaries name characters.
      check(
        "no summary carries attendance, a clock time, or source trivia",
        (() => {
          const players =
            /\b(Derek|Alex|Andrew|Julie|Max|Scott|Steph|Gaige|Caprica|Drew|Hank)\b/;
          const clock = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;
          const meta = /\b(OneNote|Discord|session|attendance|XP)\b/i;
          return R.every(
            (r) =>
              r.description === undefined ||
              (!players.test(r.description) &&
                !clock.test(r.description) &&
                !meta.test(r.description))
          );
        })()
      );
      // Twenty sessions left no account of their events in either
      // source. They carry NO description rather than an invented one,
      // and that silence is deliberate enough to pin.
      check(
        "sessions with no recorded events stay empty rather than invented",
        R.filter((r) => r.description === undefined).length === 20 &&
          R.filter((r) => r.description !== undefined).every(
            (r) => r.description.trim().length > 20
          )
      );
    }

    // ---- a group is matched by name, not by spelling ---------------
    // The field is free text typed into Airtable and nobody typed it
    // twice the same way. Matching on the raw string files one guild
    // under two rows with half its members each.
    {
      const groups = await import(
        pathToFileURL(join(compile("convex/groups.ts"), "groups.js")).href
      ).catch(() => null);
      if (groups) {
        check(
          "spacing and case do not make a second group",
          groups.groupKey("  Mining   Guild ") === groups.groupKey("mining guild")
        );
        check(
          "an empty name keys to nothing, so it can be skipped",
          groups.groupKey("   ") === ""
        );
      }
    }

    // ---- typing # in the notes -------------------------------------
    // The whole question this has to get right is SPACES. Names here
    // have them, so the query cannot end at one — which means the text
    // never says where a name stops, and something else must.
    {
      const nl = await import(
        pathToFileURL(join(compile("components/noteLinks.ts"), "noteLinks.js"))
          .href
      );

      const read = (text, caret = text.length) => nl.readHashQuery(text, caret);

      check(
        "a name with a space is one query, not two",
        read("#Kelja Ironfist")?.query === "Kelja Ironfist"
      );
      check(
        "and it knows where the # was, so it can be replaced",
        read("Bruno met #Kelja Iron")?.at === 10 &&
          read("Bruno met #Kelja Iron")?.query === "Kelja Iron"
      );
      check(
        "a # nobody has typed after is an empty query, not nothing",
        read("Bruno met #")?.query === ""
      );

      // A # mid-word is somebody writing, not somebody searching.
      check("C# is not a search", read("C#") === null);
      check("nor is item#3", read("item#3") === null);
      // A contentEditable is full of non-breaking spaces — the app
      // puts one after every link it inserts — and one of those
      // before a # is still a space. Written as an escape: an
      // invisible character in source is a character nobody edits
      // correctly.
      check(
        "a # after a non-breaking space still opens one",
        read("Bruno met\u00a0#Kel")?.query === "Kel"
      );

      check(
        "the caret before the # sees no query",
        read("#Kelja", 0) === null
      );
      check(
        "the LAST # is the one being typed",
        read("#done #Kel")?.at === 6
      );
      check(
        "a run too long to be a name gives up",
        read(`#${"a".repeat(61)}`) === null
      );
      check(
        "and one that crossed a line break gives up too",
        read("#Kel\nja") === null
      );

      // "#3 on the list" reads as a query, matches nothing, and so
      // shows no panel — which is the behaviour, not an oversight.
      const TARGETS = [
        { kind: "npc", name: "Kelja Ironfist" },
        { kind: "npc", name: "Bruno" },
        { kind: "group", name: "Mining Guild" },
      ];
      check(
        "a # somebody meant literally matches nothing",
        nl.matchTargets(TARGETS, read("#3 on the list").query).length === 0
      );

      // Finishing the name is enough — no Enter, no click. This is the
      // half that makes "#Kelja Ironfist" a link on its own.
      check(
        "a query that names one thing exactly is that thing",
        nl.exactTarget(TARGETS, "Kelja Ironfist")?.name === "Kelja Ironfist"
      );
      check(
        "odd spacing and case do not stop it",
        nl.exactTarget(TARGETS, "  kelja   IRONFIST ")?.name ===
          "Kelja Ironfist"
      );
      check(
        "a partial name is not a finished one",
        nl.exactTarget(TARGETS, "Kelja") === null
      );
      check("and nothing at all is not", nl.exactTarget(TARGETS, "  ") === null);

      // The guard on auto-linking: something LONGER starting the same
      // way means the typing may not be finished. Linking "Kelja" the
      // moment it matched would make "Kelja Ironfist" unreachable —
      // the link would land before the space was pressed.
      const BOTH = [
        { kind: "npc", name: "Kelja" },
        { kind: "npc", name: "Kelja Ironfist" },
      ];
      check(
        "a name that another name extends waits to be chosen",
        nl.exactTarget(BOTH, "Kelja") === null
      );
      check(
        "and the longer one still links itself once it is complete",
        nl.exactTarget(BOTH, "Kelja Ironfist")?.name === "Kelja Ironfist"
      );
      check(
        "two things with one name is a choice, not an answer",
        nl.exactTarget(
          [
            { kind: "npc", name: "Kelja Ironfist" },
            { kind: "group", name: "Kelja Ironfist" },
          ],
          "Kelja Ironfist"
        ) === null
      );

      // And the link a space-containing name becomes actually works.
      check(
        "the space survives into the href",
        nl
          .linkHtml("c1", { kind: "npc", name: "Kelja Ironfist" })
          .includes("/campaign/c1/npcs?open=Kelja%20Ironfist")
      );
    }

    // ---- the picture on a heading that has no entry ----------------
    // A species family head is synthetic: no document, and so no
    // artwork, which left exactly the rows that HAVE variants as the
    // blank squares in a table of pictures. It borrows one from
    // underneath, and which one it borrows is the whole of this.
    {
      const lf = look;

      check(
        "the Player's Handbook printing supplies the picture",
        lf.familyImage([
          { name: "Wood Elf", source: "MotM", image: "a.png" },
          { name: "Elf", source: "PHB", image: "b.png" },
          { name: "High Elf", source: "SCAG", image: "c.png" },
        ]) === "b.png"
      );
      check(
        "the 2014 book beats the 2024 one, which is what a 5e game reads",
        lf.familyImage([
          { name: "Elf", source: "XPHB", image: "new.png" },
          { name: "Elf", source: "PHB", image: "old.png" },
        ]) === "old.png"
      );
      check(
        "with no PHB at all, the 2024 book still beats a supplement",
        lf.familyImage([
          { name: "Wood Elf", source: "MotM", image: "a.png" },
          { name: "Elf", source: "XPHB", image: "b.png" },
        ]) === "b.png"
      );
      check(
        "otherwise the first printing in the list",
        lf.familyImage([
          { name: "Wood Elf", source: "MotM", image: "a.png" },
          { name: "High Elf", source: "SCAG", image: "b.png" },
        ]) === "a.png"
      );
      // The first WITH ART rather than simply the first: a leading
      // variant with no picture would leave the heading blank while
      // every row under it had one, which is the gap being closed.
      check(
        "a variant with no picture is skipped rather than chosen",
        lf.familyImage([
          { name: "Wood Elf", source: "MotM" },
          { name: "High Elf", source: "SCAG", image: "" },
          { name: "Drow Elf", source: "PHB2", image: "c.png" },
        ]) === "c.png"
      );
      check(
        "a family nobody drew stays undrawn",
        lf.familyImage([{ name: "Wood Elf", source: "MotM" }]) === undefined
      );
      check(
        "a book's printing year does not hide the book",
        lf.familyImage([
          { name: "Wood Elf", source: "MotM", image: "a.png" },
          { name: "Elf", source: "PHB 2014", image: "b.png" },
        ]) === "b.png"
      );

      // And the heading speciesRows builds actually wears one.
      const withArt = lf.speciesRows([
        { _id: "e1", name: "High Elf", source: "SCAG", image: "high.png" },
        { _id: "e2", name: "Elf", source: "PHB", image: "elf.png" },
        { _id: "e3", name: "Wood Elf", source: "PHB", image: "wood.png" },
      ]);
      const head = withArt.rows.find((r) => r.absent === true);
      check(
        "a species heading carries a picture borrowed from underneath",
        head?.image === "elf.png"
      );
    }

    // ---- a page is not a box, and the id is what says so -----------
    // The format toolbar knows one kind of thing: a region with an id.
    // Two kinds answer to that now, reached by different mutations, so
    // an id that read wrong would send a page edit to updateBox — where
    // it is not a document id and Convex refuses it in a way nobody can
    // read.
    {
      const np = await import(
        pathToFileURL(join(compile("components/notePage.ts"), "notePage.js"))
          .href
      );

      check(
        "a page id round-trips to its side",
        np.pageSide(np.pageBoxId("dm")) === "dm" &&
          np.pageSide(np.pageBoxId("player")) === "player"
      );
      check(
        "a real box id is not a page",
        np.pageSide("k17ezhmgzwdzfb0pr0ctahsgrx8cqn8a") === null
      );
      check(
        "a prefixed id naming no real side is not a page either",
        np.pageSide("page:everyone") === null && np.pageSide("page:") === null
      );
      check(
        "and nothing at all is not a page",
        np.pageSide(undefined) === null && np.pageSide(null) === null
      );
    }

    // ---- a rectangle drawn on a picture of the screen --------------
    // The capture itself needs a browser and a person clicking a share
    // picker. The arithmetic between "where the hand went" and "which
    // pixels to keep" needs neither, and is where this goes wrong: a
    // backwards drag, a drag that leaves the image, a display size that
    // is not the image's size.
    {
      const sg = await import(
        pathToFileURL(join(compile("components/screenGrab.ts"), "screenGrab.js"))
          .href
      );

      const back = sg.normalizeRect(300, 260, 100, 60);
      check(
        "a drag up and to the left is still a rectangle",
        back.x === 100 && back.y === 60 && back.w === 200 && back.h === 200
      );
      check(
        "a drag down and to the right agrees with it",
        JSON.stringify(sg.normalizeRect(100, 60, 300, 260)) ===
          JSON.stringify(back)
      );

      // The overlay shows the capture shrunk to fit; the crop happens
      // in the capture's own pixels.
      const scaled = sg.toNatural(
        { x: 50, y: 25, w: 100, h: 50 },
        { w: 500, h: 250 },
        { w: 1000, h: 500 }
      );
      check(
        "a crop scales from the displayed size to the real one",
        scaled.x === 100 &&
          scaled.y === 50 &&
          scaled.w === 200 &&
          scaled.h === 100
      );

      // A drag that leaves the image reports coordinates outside it,
      // and a crop starting at -40 comes back with a transparent band.
      const off = sg.toNatural(
        { x: -40, y: -40, w: 100, h: 100 },
        { w: 500, h: 500 },
        { w: 500, h: 500 }
      );
      check(
        "a crop that starts off the image starts at its corner",
        off.x === 0 && off.y === 0
      );

      const over = sg.toNatural(
        { x: 400, y: 400, w: 400, h: 400 },
        { w: 500, h: 500 },
        { w: 500, h: 500 }
      );
      check(
        "a crop cannot run off the far edge either",
        over.x === 400 && over.w === 100 && over.h === 100
      );

      check(
        "a crop of nothing, from an image with no size, is nothing",
        JSON.stringify(
          sg.toNatural({ x: 10, y: 10, w: 10, h: 10 }, { w: 0, h: 0 }, { w: 9, h: 9 })
        ) === JSON.stringify({ x: 0, y: 0, w: 0, h: 0 })
      );

      check(
        "a click is not a crop",
        sg.isTinyRect({ x: 4, y: 4, w: 2, h: 2 }) === true
      );
      check(
        "a rectangle one side of which is a hair wide is not a crop",
        sg.isTinyRect({ x: 0, y: 0, w: 400, h: 3 }) === true
      );
      check(
        "a deliberate rectangle is",
        sg.isTinyRect({ x: 0, y: 0, w: 40, h: 40 }) === false
      );

      // Two shots of a still screen are two attachments, not one: the
      // form drops a file whose name and size match one already there.
      check(
        "a capture is named for the moment it was taken",
        /^page-\d{4}-\d{2}-\d{2}T/.test(
          sg.shotFile(new Blob(["x"], { type: "image/png" }), "page").name
        )
      );
    }

    // ---- a window you can move and resize --------------------------
    // Every bug here is an unreachable window: a title bar dragged
    // above the top of the screen, a corner pulled until the frame is
    // smaller than its own close button, a browser resized under a
    // window parked at the right edge.
    {
      const fw = await import(
        pathToFileURL(
          join(compile("components/floatWindow.ts"), "floatWindow.js")
        ).href
      );
      const view = { w: 1200, h: 800 };

      const opened = fw.initialBox(view, { w: 544, h: 620 });
      check(
        "a window opens centred at the size it asked for",
        opened.w === 544 &&
          opened.h === 620 &&
          opened.x === Math.round((1200 - 544) / 2) &&
          opened.y === Math.round((800 - 620) / 2)
      );

      const cramped = fw.initialBox({ w: 700, h: 400 }, { w: 900, h: 900 });
      check(
        "a window too big for the screen opens fitting it",
        cramped.w <= 700 && cramped.h <= 400 && cramped.x >= 0 && cramped.y >= 0
      );

      const box = { x: 400, y: 300, w: 544, h: 620 };

      check(
        "dragging up past the top leaves the title bar on screen",
        fw.moveBox(box, 0, -5000, view).y === 0
      );
      check(
        "dragging off the right leaves the window on screen",
        fw.moveBox(box, 5000, 0, view).x === view.w - box.w
      );

      // The reason move takes the box the drag STARTED from: clamping
      // is not cumulative, so a drag into an edge and back out lands
      // where the hand is rather than short of it by whatever the edge
      // refused.
      check(
        "a drag past an edge and back lands under the hand",
        fw.moveBox(box, 10, 10, view).x === 410 &&
          fw.moveBox(box, -5000, 0, view).x === 0
      );

      const small = fw.resizeBox(box, -5000, -5000, view);
      check(
        "a window cannot be shrunk into nothing",
        small.w === fw.MIN_W && small.h === fw.MIN_H
      );
      check(
        "and shrinking it does not move it",
        small.x === box.x && small.y === box.y
      );

      const grown = fw.resizeBox(box, 5000, 5000, view);
      check(
        "growing a window stops at the edge of the screen",
        grown.x === box.x &&
          grown.y === box.y &&
          grown.x + grown.w === view.w &&
          grown.y + grown.h === view.h
      );

      check(
        "a browser shrunk under a window pulls the window back into it",
        (() => {
          const pulled = fw.clampBox({ x: 900, y: 700, w: 544, h: 620 }, {
            w: 1000,
            h: 900,
          });
          return (
            pulled.x + pulled.w <= 1000 &&
            pulled.y + pulled.h <= 900 &&
            pulled.x >= 0 &&
            pulled.y >= 0
          );
        })()
      );

      // A viewport narrower than the smallest allowed window: the range
      // to clamp into is inverted, and the naive reading pins the box
      // to a corner it cannot be dragged out of.
      const tiny = fw.clampBox({ x: 50, y: 50, w: 544, h: 620 }, {
        w: 200,
        h: 150,
      });
      check(
        "a window bigger than the whole viewport sits at its corner",
        tiny.x === 0 && tiny.y === 0 && tiny.w === fw.MIN_W
      );
      check(
        "and can still be pushed the other way to see its far side",
        fw.clampBox({ x: -5000, y: 0, w: 544, h: 620 }, { w: 200, h: 150 }).x ===
          200 - fw.MIN_W
      );
    }

    /* ---- the Session Recorder's pure half ------------------------
     *
     * Two of the functions here parse input from outside this repo —
     * WhisperX's segments and a model's JSON — so most of what follows
     * is malformed on purpose. The interesting cases are not "does it
     * work", they are "what does it do with a number where a string
     * belongs", because that is what will actually arrive one night.
     */
    {
      const rm = await import(
        pathToFileURL(
          join(compile("components/recorderModel.ts"), "recorderModel.js")
        ).href
      );

      // ---- the status machine ---------------------------------------
      check(
        "every stage has a label and a note",
        rm.RECORDER_STAGES.every(
          (s) =>
            typeof rm.STATUS_LABEL[s] === "string" &&
            rm.STATUS_LABEL[s] !== "" &&
            typeof rm.STATUS_NOTE[s] === "string" &&
            rm.STATUS_NOTE[s] !== ""
        )
      );
      check(
        "and no label or note exists for a stage that does not",
        Object.keys(rm.STATUS_LABEL).length === rm.RECORDER_STAGES.length &&
          Object.keys(rm.STATUS_NOTE).length === rm.RECORDER_STAGES.length
      );
      check(
        "a status the server invented is not a status",
        !rm.isRecorderStatus("thinking") &&
          !rm.isRecorderStatus(null) &&
          !rm.isRecorderStatus(3) &&
          rm.isRecorderStatus("transcribing")
      );
      check("an unknown status has no place on the rail", rm.stageIndex("x") === -1);
      check(
        "transcribed is a resting state, not a step towards done",
        rm.isSettled("transcribed") &&
          rm.isSettled("done") &&
          rm.isSettled("failed") &&
          !rm.isSettled("transcribing") &&
          !rm.isSettled("queued")
      );
      check(
        "the three states the home server owns are the busy ones",
        rm.isServerBusy("queued") &&
          rm.isServerBusy("transcribing") &&
          rm.isServerBusy("summarizing") &&
          !rm.isServerBusy("recording") &&
          !rm.isServerBusy("done")
      );

      // ---- clock and bytes ------------------------------------------
      check("under a minute", rm.formatClock(7) === "0:07");
      check("minutes and seconds", rm.formatClock(247) === "4:07");
      check("an hour appears exactly at one", rm.formatClock(3600) === "1:00:00");
      check("and pads the minutes once it has", rm.formatClock(3863) === "1:04:23");
      check("a fraction of a second rounds down", rm.formatClock(59.9) === "0:59");
      check(
        "a MediaRecorder that has not started is 0:00, not NaN",
        rm.formatClock(NaN) === "0:00" &&
          rm.formatClock(undefined) === "0:00" &&
          rm.formatClock("4") === "0:00" &&
          rm.formatClock(-30) === "0:00"
      );
      check(
        "bytes read the way an operating system writes them",
        rm.formatBytes(0) === "0 B" &&
          rm.formatBytes(900) === "900 B" &&
          rm.formatBytes(1024) === "1 KB" &&
          rm.formatBytes(1536) === "2 KB" &&
          rm.formatBytes(60 * 1024 * 1024) === "60.0 MB" &&
          rm.formatBytes(1536 * 1024 * 1024) === "1.5 GB"
      );
      check(
        "kilobytes stay whole and megabytes get their decimal",
        !rm.formatBytes(5000).includes(".") && rm.formatBytes(5e6).includes(".")
      );
      check("and a bad number is nothing, not NaN B", rm.formatBytes(null) === "0 B");

      // ---- cleanSegments: this is a POST body, not a value ----------
      check(
        "anything that is not an array is no transcript",
        rm.cleanSegments(null).length === 0 &&
          rm.cleanSegments({ segments: [] }).length === 0 &&
          rm.cleanSegments("[]").length === 0
      );
      check(
        "entries that are not objects are skipped, not thrown on",
        rm.cleanSegments([null, 3, "hi", { text: "kept" }]).length === 1
      );
      check(
        "a segment with no words is not a segment",
        rm.cleanSegments([{ start: 0, end: 1, text: "   " }]).length === 0
      );
      const repaired = rm.cleanSegments([
        { start: -5, end: "x", text: "  hello  ", speaker: "  SPEAKER_01  " },
      ]);
      check(
        "a bad start, a bad end and a padded speaker are all repaired",
        repaired.length === 1 &&
          repaired[0].start === 0 &&
          repaired[0].end === 0 &&
          repaired[0].text === "hello" &&
          repaired[0].speaker === "SPEAKER_01"
      );
      check(
        "an end before its start is pulled up to it rather than kept",
        rm.cleanSegments([{ start: 10, end: 2, text: "a" }])[0].end === 10
      );
      check(
        "a null speaker leaves the key off entirely",
        !("speaker" in rm.cleanSegments([{ start: 0, end: 1, text: "a", speaker: null }])[0]) &&
          !("speaker" in rm.cleanSegments([{ start: 0, end: 1, text: "a", speaker: "  " }])[0])
      );
      check(
        "one absurd segment cannot blow the document limit",
        rm.cleanSegments([{ start: 0, end: 1, text: "x".repeat(50000) }])[0].text
          .length === rm.MAX_SEGMENT_TEXT
      );
      check(
        "and neither can an absurd number of them",
        rm.cleanSegments(
          Array.from({ length: 25 }, () => ({ start: 0, end: 1, text: "a" })),
          10
        ).length === 10
      );

      // ---- toTurns --------------------------------------------------
      const seg = (start, end, text, speaker) =>
        speaker === undefined
          ? { start, end, text }
          : { start, end, text, speaker };

      const merged = rm.toTurns([
        seg(0, 2, "one", "A"),
        seg(2, 4, "two", "A"),
        seg(4, 6, "three", "B"),
      ]);
      check(
        "consecutive segments from one voice become one turn",
        merged.length === 2 &&
          merged[0].text === "one two" &&
          merged[0].end === 4 &&
          merged[1].speaker === "B"
      );
      check(
        "a long silence ends a turn even for the same voice",
        rm.toTurns([
          seg(0, 2, "before", "A"),
          seg(2 + rm.TURN_GAP + 1, 40, "after", "A"),
        ]).length === 2
      );
      check(
        "and a gap right at the threshold does not",
        rm.toTurns([
          seg(0, 2, "before", "A"),
          seg(2 + rm.TURN_GAP, 40, "after", "A"),
        ]).length === 1
      );
      check(
        "a monologue still breaks into readable turns",
        rm.toTurns(
          Array.from({ length: 40 }, (_, i) =>
            seg(i * 2, i * 2 + 2, "w".repeat(100), "A")
          )
        ).length > 1
      );
      check(
        "every turn stays inside the character cap",
        rm
          .toTurns(
            Array.from({ length: 40 }, (_, i) =>
              seg(i * 2, i * 2 + 2, "w".repeat(100), "A")
            )
          )
          .every((t) => t.text.length <= rm.TURN_CHARS)
      );
      check(
        "unattributed segments merge with each other and not with a name",
        (() => {
          const t = rm.toTurns([seg(0, 1, "a"), seg(1, 2, "b"), seg(2, 3, "c", "A")]);
          return t.length === 2 && t[0].speaker === "" && t[0].text === "a b";
        })()
      );
      check("no segments, no turns", rm.toTurns([]).length === 0);

      // ---- who was speaking -----------------------------------------
      const cast = [
        seg(0, 10, "long", "B"),
        seg(10, 12, "short", "A"),
        seg(12, 30, "longer", "B"),
        seg(30, 31, "none"),
      ];
      check(
        "tags come back in the order they first speak, once each",
        JSON.stringify(rm.speakerTags(cast)) === JSON.stringify(["B", "A"])
      );
      check(
        "speaking time adds up per voice, unattributed included",
        rm.speakingTime(cast).get("B") === 28 &&
          rm.speakingTime(cast).get("A") === 2 &&
          rm.speakingTime(cast).get("") === 1
      );

      // ---- speakerName: the colorOf trap, again ---------------------
      check(
        "a named voice prints its name",
        rm.speakerName("SPEAKER_00", { SPEAKER_00: "  Derek  " }) === "Derek"
      );
      check(
        "WhisperX counts from zero and people do not",
        rm.speakerName("SPEAKER_00", {}) === "Speaker 1" &&
          rm.speakerName("SPEAKER_12", null) === "Speaker 13"
      );
      check(
        "no tag at all is unattributed, not Speaker NaN",
        rm.speakerName("", {}) === "Unattributed" &&
          rm.speakerName("   ", undefined) === "Unattributed"
      );
      check(
        "a blank stored name falls back rather than printing nothing",
        rm.speakerName("SPEAKER_00", { SPEAKER_00: "   " }) === "Speaker 1"
      );
      check(
        "a name that is not a string is not a name",
        rm.speakerName("SPEAKER_00", { SPEAKER_00: 7 }) === "Speaker 1"
      );
      // The specific bug this exists for: `names[tag]` on a plain object
      // returns Object.prototype.toString for this tag — a FUNCTION,
      // which is truthy, which React then stringifies into the page.
      check(
        "a tag named toString does not reach the prototype",
        typeof rm.speakerName("toString", {}) === "string" &&
          rm.speakerName("toString", {}) === "toString"
      );
      check(
        "and an unrecognised tag prints itself rather than vanishing",
        rm.speakerName("MIC_2", {}) === "MIC_2"
      );
      // hasOwnProperty is what makes this the answer, and this is the
      // only case that proves it. Against a PLAIN object the typeof
      // guard beside it happens to cover the same ground — every
      // inherited property of one is a function — so removing
      // hasOwnProperty changed no result and no test. An inherited
      // STRING is the shape that tells them apart, and the rule it
      // pins is the real one: a name belongs to this recording's map
      // or it is not a name.
      check(
        "a name inherited rather than owned is not this recording's name",
        rm.speakerName("SPEAKER_00", Object.create({ SPEAKER_00: "Ghost" })) ===
          "Speaker 1"
      );
      check(
        "and cleanSpeakers will not store one either",
        JSON.stringify(
          rm.cleanSpeakers(Object.create({ SPEAKER_00: "Ghost" }), [
            "SPEAKER_00",
          ])
        ) === "{}"
      );

      // ---- searching ------------------------------------------------
      const turns = rm.toTurns([
        seg(0, 5, "the tower is falling", "SPEAKER_00"),
        seg(20, 25, "roll initiative", "SPEAKER_01"),
      ]);
      check("an empty search is not a filter", rm.searchTurns(turns, "  ").length === 2);
      check(
        "the words are searched, case insensitively",
        rm.searchTurns(turns, "TOWER").length === 1
      );
      check(
        "and so is the name a person actually knows them by",
        rm.searchTurns(turns, "marcus", { SPEAKER_01: "Marcus" }).length === 1
      );
      check(
        "searching a name nobody has been given finds the fallback",
        rm.searchTurns(turns, "speaker 2", {}).length === 1
      );
      check(
        "the transcript as text carries the timecode and the name",
        rm.transcriptText(turns, { SPEAKER_00: "Derek" }).split("\n")[0] ===
          "[0:00] Derek: the tower is falling"
      );

      // ---- storing it -----------------------------------------------
      const many = Array.from({ length: 300 }, (_, i) =>
        seg(i, i + 1, "w".repeat(400), "A")
      );
      const chunks = rm.chunkSegments(many);
      check(
        "a long transcript is split rather than stored whole",
        chunks.length > 1
      );
      check(
        "and no segment is lost or duplicated in the splitting",
        chunks.flat().length === many.length
      );
      check(
        "every chunk stays inside the budget once it has more than one",
        chunks.every(
          (c) =>
            c.length === 1 ||
            c.reduce((n, s) => n + s.text.length + 64, 0) <= rm.CHUNK_CHARS
        )
      );
      check(
        "a segment bigger than the budget gets a row of its own, uncut",
        (() => {
          const out = rm.chunkSegments([seg(0, 1, "x".repeat(999), "A")], 100);
          return out.length === 1 && out[0][0].text.length === 999;
        })()
      );
      check("nothing to chunk is no chunks", rm.chunkSegments([]).length === 0);
      check(
        "rows are rejoined by their index, not by the order they arrived",
        rm
          .joinChunks([
            { index: 2, segments: [seg(4, 5, "c", "A")] },
            { index: 0, segments: [seg(0, 1, "a", "A")] },
            { index: 1, segments: [seg(2, 3, "b", "A")] },
          ])
          .map((s) => s.text)
          .join("") === "abc"
      );

      // ---- cleanSummary: this is model output -----------------------
      check(
        "no summary at all",
        rm.cleanSummary(null) === null &&
          rm.cleanSummary("recap") === null &&
          rm.cleanSummary([1, 2]) === null &&
          rm.cleanSummary({}) === null
      );
      check(
        "every section empty is the same as no summary",
        rm.cleanSummary({ recap: "  ", beats: [], loot: null }) === null
      );
      const summary = rm.cleanSummary({
        recap: "  The   party   went   north.  ",
        beats: ["one", 7, null, "  two  ", ""],
        decisions: "not a list",
        npcs: ["Vex — sold them a map"],
        loot: [],
        threads: ["who owns the tower"],
        extra: "ignored",
      });
      check(
        "a fumbled section is empty rather than fatal to the rest",
        summary !== null &&
          summary.decisions.length === 0 &&
          summary.beats.length === 2 &&
          summary.beats[1] === "two"
      );
      check(
        "runs of whitespace in the recap collapse",
        summary.recap === "The party went north."
      );
      check(
        "the shape is exactly the six sections, never the model's extras",
        summary !== null &&
          JSON.stringify(Object.keys(summary).sort()) ===
            JSON.stringify(rm.SUMMARY_SECTIONS.map((s) => s.key).sort())
      );
      check(
        "a runaway list is capped",
        rm.cleanSummary({
          beats: Array.from({ length: 400 }, (_, i) => `b${i}`),
        }).beats.length === rm.MAX_LINES
      );
      check(
        "and so is a runaway line and a runaway recap",
        rm.cleanSummary({ beats: ["x".repeat(9000)] }).beats[0].length ===
          rm.MAX_LINE &&
          rm.cleanSummary({ recap: "x".repeat(90000) }).recap.length ===
            rm.MAX_RECAP
      );
      check(
        "the notes as text carry only the sections that have anything",
        (() => {
          const text = rm.summaryText(summary);
          return (
            text.includes("## Recap") &&
            text.includes("- Vex — sold them a map") &&
            !text.includes("Loot and rewards")
          );
        })()
      );
      check(
        "every prompt section names a field the summary actually has",
        rm.SUMMARY_SECTIONS.every(
          (s) =>
            typeof s.title === "string" &&
            typeof s.asked === "string" &&
            s.asked !== "" &&
            (s.kind === "prose" || s.kind === "list") &&
            Object.prototype.hasOwnProperty.call(summary, s.key)
        )
      );

      // ---- titles and speaker maps ----------------------------------
      check(
        "an empty title is the fallback, not an empty row",
        rm.cleanTitle("") === "Untitled recording" &&
          rm.cleanTitle("   ") === "Untitled recording" &&
          rm.cleanTitle(null) === "Untitled recording" &&
          rm.cleanTitle(42) === "Untitled recording"
      );
      check(
        "a title is collapsed and capped",
        rm.cleanTitle("  a   b  ") === "a b" &&
          rm.cleanTitle("x".repeat(400)).length === rm.MAX_TITLE
      );
      check(
        "a name for a voice that is not in this recording is dropped",
        JSON.stringify(
          rm.cleanSpeakers({ SPEAKER_00: "Derek", SPEAKER_99: "Ghost" }, [
            "SPEAKER_00",
          ])
        ) === JSON.stringify({ SPEAKER_00: "Derek" })
      );
      check(
        "clearing a name removes the key rather than storing a blank",
        JSON.stringify(rm.cleanSpeakers({ SPEAKER_00: "   " }, ["SPEAKER_00"])) ===
          "{}"
      );
      check(
        "a map that is not an object is no map",
        JSON.stringify(rm.cleanSpeakers(null, ["A"])) === "{}" &&
          JSON.stringify(rm.cleanSpeakers(["A"], ["A"])) === "{}"
      );
      check(
        "cleanSpeakers does not read the prototype either",
        JSON.stringify(rm.cleanSpeakers({}, ["toString"])) === "{}"
      );
      check(
        "and it cannot be made to store more voices than a table has",
        Object.keys(
          rm.cleanSpeakers(
            Object.fromEntries(
              Array.from({ length: 200 }, (_, i) => [`SPEAKER_${i}`, `n${i}`])
            ),
            Array.from({ length: 200 }, (_, i) => `SPEAKER_${i}`)
          )
        ).length === rm.MAX_SPEAKERS
      );

      // ---- where the audio is sent ----------------------------------
      check(
        "https is the only way audio leaves the browser",
        rm.isUploadUrl("https://maps.example.com/recorder") &&
          !rm.isUploadUrl("http://maps.example.com/recorder")
      );
      check(
        "except on the machine the server is running on",
        rm.isUploadUrl("http://localhost:8080") &&
          rm.isUploadUrl("http://127.0.0.1:8080")
      );
      check(
        "credentials in the URL are refused",
        !rm.isUploadUrl("https://user:pass@maps.example.com/recorder")
      );
      check(
        "and so is anything that is not a URL",
        !rm.isUploadUrl("") &&
          !rm.isUploadUrl("   ") &&
          !rm.isUploadUrl(null) &&
          !rm.isUploadUrl("maps.example.com") &&
          !rm.isUploadUrl("ftp://maps.example.com")
      );
      check(
        "a trailing slash on the configured URL does not double up",
        rm.chunkUrl("https://h/recorder/", "abc", 3) ===
          "https://h/recorder/chunk/abc/3" &&
          rm.finishUrl("https://h/recorder///", "abc") ===
            "https://h/recorder/finish/abc"
      );
      check(
        "and the id is escaped rather than pasted into the path",
        rm.chunkUrl("https://h", "a/b", 0) === "https://h/chunk/a%2Fb/0"
      );
    }

    // ---- a session's tabs, away from the database ------------------
    // Which tabs a person is offered, in what order, and what a tab key
    // means. The order and the dmOnly flags are held by the integrity
    // guard; what is here is the behaviour around the edges — a name
    // that is only spaces, a tab deleted while you were on it, a page
    // id that is really a box id.
    {
      const st = await import(
        pathToFileURL(
          join(compile("components/sessionTabs.ts"), "sessionTabs.js")
        ).href
      );

      const tab = (id, over = {}) => ({
        _id: id,
        _creationTime: 1,
        title: id,
        dmOnly: false,
        order: 1,
        ...over,
      });

      check(
        "a player is offered the player page and no DM tab",
        (() => {
          const keys = st.orderTabs(false, []).map((t) => t.key);
          return keys.length === 1 && keys[0] === "player";
        })()
      );
      check(
        "a DM is offered all three, DM first",
        JSON.stringify(st.orderTabs(true, []).map((t) => t.key)) ===
          JSON.stringify(["dm", "prep", "player"])
      );
      check(
        "a player's own tabs come after the page they share",
        JSON.stringify(
          st.orderTabs(false, [tab("b", { order: 2 }), tab("a", { order: 1 })])
            .map((t) => t.key)
        ) === JSON.stringify(["player", "a", "b"])
      );
      check(
        "two tabs made at the same position fall back to which came first",
        JSON.stringify(
          st
            .orderTabs(false, [
              tab("late", { order: 1, _creationTime: 99 }),
              tab("early", { order: 1, _creationTime: 2 }),
            ])
            .map((t) => t.key)
        ) === JSON.stringify(["player", "early", "late"])
      );
      // orderTabs takes the caller's OWN rows; a hidden tab reaching it
      // would mean the query already went wrong. It is not a filter and
      // is not asked to be one — the DM-only BUILT-INS are what it
      // drops.
      check(
        "the built-ins it drops are the DM's own",
        st
          .orderTabs(false, [])
          .every((t) => t.dmOnly === false)
      );

      check(
        "a tab name is one line, collapsed and trimmed",
        st.tabTitle("  Loot   and   levels ") === "Loot and levels"
      );
      check(
        "a name of nothing but spaces is no name",
        !st.isValidTitle("   ") && !st.isValidTitle("") && !st.isValidTitle(null)
      );
      check(
        "a pasted paragraph becomes a tab rather than an error",
        st.tabTitle("x".repeat(200)).length === st.MAX_TAB_TITLE &&
          st.isValidTitle("x".repeat(200))
      );

      const three = st.orderTabs(true, [tab("mine")]);
      check(
        "the tab you were on is the tab you stay on",
        st.activeTabKey(three, "mine") === "mine"
      );
      check(
        "a tab deleted under you falls back to the first, not to nothing",
        st.activeTabKey(three, "gone") === "dm"
      );
      check(
        "and with nothing to show, the player page is the answer",
        st.activeTabKey([], "dm") === "player"
      );

      check(
        "a page id round-trips to its tab",
        st.pageTabKey(st.pageBoxId("prep")) === "prep" &&
          st.pageTabKey(st.pageBoxId("k17ezhmgzwdzfb0pr0ctahsgrx8cqn8a")) ===
            "k17ezhmgzwdzfb0pr0ctahsgrx8cqn8a"
      );
      check(
        "a real box id is not a page",
        st.pageTabKey("k17ezhmgzwdzfb0pr0ctahsgrx8cqn8a") === null
      );
      check(
        "and neither is a prefix with no tab after it",
        st.pageTabKey("page:") === null &&
          st.pageTabKey(undefined) === null &&
          st.pageTabKey(null) === null
      );
    }

    return problems;
  },
};
