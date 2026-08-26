/**
 * Guard 4 — the dangling-reference sweep.
 *
 * This is the guard that exists because of how silent losses actually
 * happen: not a syntax error, but a reference to something that no
 * longer exists, in a place the compiler can't see.
 *
 * TypeScript does not cover any of these, because each one crosses a
 * boundary where a field name is a *string*:
 *   - the grid addresses NPC fields by string key, through a
 *     Record<string, unknown> cast, so a typo silently renders blanks
 *   - the sidebar addresses routes by slug, so a renamed folder becomes
 *     a dead link rather than a compile error
 *   - the importer writes field names that only the deployed schema
 *     validates, i.e. at import time, on real data
 *   - the query hands back fields the schema may no longer have
 */

import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import {
  read,
  exists,
  appPath,
  blockAfter,
  topLevelKeys,
  stringProps,
  constArrayStrings,
  stripComments,
  sourceFiles,
  literalUnionAfter,
} from "./lib.mjs";

/** Convex adds these to every document. */
const SYSTEM_FIELDS = ["_id", "_creationTime"];

/**
 * The reference library: shared across campaigns, read-only in the app,
 * and the only tables whose contents can be thrown away and re-imported.
 * Several checks below turn on exactly that property.
 */
const LOOKUP_TABLES = [
  "spells",
  "items",
  "monsters",
  "feats",
  "backgrounds",
  "classes",
  "species",
];

/**
 * Fields the query COMPUTES rather than reads from the table.
 *
 * Listed explicitly rather than letting the check wave through anything
 * unrecognised: adding a derived field should be a deliberate line here,
 * so a typo'd real field still fails loudly.
 *
 *   portraitUrl — resolved from the portraitId storage id, since the
 *                 client must never handle storage ids directly.
 */
const DERIVED_FIELDS = ["portraitUrl"];

export const integrity = {
  name: "integrity",
  description: "no dangling references across schema, query, grid, and routes",
  run() {
    const problems = [];

    // ---- what the schema actually defines -------------------------
    const schemaSrc = read("convex", "schema.ts");
    const npcsBlockSrc = blockAfter(
      schemaSrc,
      /npcs:\s*defineTable\(/,
      "npcs table in schema.ts"
    );
    const schemaFields = topLevelKeys(npcsBlockSrc, "npcs schema");

    // ---- what the query actually returns ---------------------------
    const npcsSrc = read("convex", "npcs.ts");
    const returned = topLevelKeys(
      blockAfter(npcsSrc, /\.map\((?:async )?\(n\)\s*=>\s*\(/, "the row shaper in npcs.ts"),
      "listForCampaign row"
    );

    for (const f of returned) {
      if (SYSTEM_FIELDS.includes(f) || DERIVED_FIELDS.includes(f)) continue;
      if (!schemaFields.includes(f)) {
        problems.push(
          `npcs.listForCampaign returns \`${f}\`, which is not a field on the npcs table`
        );
      }
    }

    // ---- what the grid addresses by string key ---------------------
    // Column definitions live in npcColumns.ts and address NPC fields by
    // string; nothing type-checks that a key still exists.
    const colsSrc = read("components", "npcColumns.ts");
    const columnsBlock = colsSrc.slice(
      colsSrc.indexOf("export const COLUMNS"),
      colsSrc.indexOf("export const COLUMN_BY_KEY")
    );
    const columnKeys = stringProps(columnsBlock, "key", "npcColumns COLUMNS");

    const available = new Set([...returned, ...DERIVED_FIELDS]);
    for (const key of columnKeys) {
      if (!available.has(key)) {
        problems.push(
          `npcColumns defines a \`${key}\` column, which npcs.listForCampaign never returns`
        );
      }
    }

    // ---- and the same for the Groups grid, one table over ----------
    // Its rows are not documents: three of the five columns are
    // computed by groups.listForCampaign out of the roster and out of
    // storage, and one of them is not on the groups table at all. So
    // the columns are checked against what the QUERY returns rather
    // than against the schema — which is the only thing the grid ever
    // sees.
    {
      const groupsSrc = read("convex", "groups.ts");
      const returnedGroup = topLevelKeys(
        blockAfter(
          groupsSrc,
          /const rows:\s*\{/,
          "the row shape in groups.ts"
        ),
        "groups.listForCampaign row"
      );
      if (returnedGroup.length === 0) {
        throw new Error("read no row fields out of convex/groups.ts");
      }

      const groupColsSrc = read("components", "groupColumns.ts");
      const groupBlock = groupColsSrc.slice(
        groupColsSrc.indexOf("export const GROUP_COLUMNS"),
        groupColsSrc.indexOf("export const GROUP_COLUMN_BY_KEY")
      );
      const groupKeys = stringProps(
        groupBlock,
        "key",
        "groupColumns GROUP_COLUMNS"
      );
      if (groupKeys.length === 0) {
        throw new Error("read no column keys out of groupColumns.ts");
      }

      for (const key of groupKeys) {
        if (!returnedGroup.includes(key)) {
          problems.push(
            `groupColumns defines a \`${key}\` column, which ` +
              "groups.listForCampaign never returns — it would be a column " +
              "of blanks"
          );
        }
      }

      // A derived column must not be editable. The grid would open a
      // cell, take what you typed, and save it nowhere — membership is
      // a field on the NPC, and the count and the pictures are read
      // out of the roster and out of storage.
      for (const entry of groupBlock.split(/\},\s*\n/)) {
        const m = entry.match(/key:\s*"([^"]+)"/);
        if (!m) continue;
        if (
          ["members", "memberCount", "attachments"].includes(m[1]) &&
          /editable:\s*true/.test(entry)
        ) {
          problems.push(
            `the Groups grid's \`${m[1]}\` column is editable, but nothing ` +
              "stores it — an edit there would vanish on the next " +
              "subscription update"
          );
        }
      }

      // The facet keys are what "Group by" offers. One that is not a
      // column has no label to offer it under.
      const facets = (
        groupColsSrc.match(/GROUP_FACET_KEYS = \[([^\]]*)\]/s)?.[1] ?? ""
      )
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      for (const key of facets) {
        if (!groupKeys.includes(key)) {
          problems.push(
            `GROUP_FACET_KEYS names \`${key}\`, which is not a Groups ` +
              "column — Group by would offer an unlabelled option that " +
              "buckets everything under —"
          );
        }
      }
    }

    // ---- and the Sessions grid ------------------------------------
    // Same check, one table further over. The wrinkle here is the
    // PRIMARY column: it is a number rather than a name, so the shared
    // default sort ("name") would sort this list on a field no row has
    // — every row blank, every row equal, and the order whatever the
    // database happened to return. The view has to bring its own.
    {
      const sessionsSrc = read("convex", "sessions.ts");
      const returnedSession = topLevelKeys(
        blockAfter(
          sessionsSrc,
          /sessions: page\.map\(\(s\) => \(/,
          "the row shaper in sessions.ts"
        ),
        "sessions.listForCampaign row"
      );

      const sessionColsSrc = read("components", "sessionColumns.ts");
      const sessionBlock = sessionColsSrc.slice(
        sessionColsSrc.indexOf("export const SESSION_COLUMNS"),
        sessionColsSrc.indexOf("export const SESSION_COLUMN_BY_KEY")
      );
      const sessionKeys = stringProps(
        sessionBlock,
        "key",
        "sessionColumns SESSION_COLUMNS"
      );
      if (sessionKeys.length === 0) {
        throw new Error("read no column keys out of sessionColumns.ts");
      }

      for (const key of sessionKeys) {
        if (!returnedSession.includes(key)) {
          problems.push(
            `sessionColumns defines a \`${key}\` column, which ` +
              "sessions.listForCampaign never returns — it would be a " +
              "column of blanks"
          );
        }
      }

      const primary = /SESSION_PRIMARY_COLUMN = "(\w+)"/.exec(sessionColsSrc);
      const defaultSort = /SESSION_DEFAULT_SORT = \{ key: "(\w+)"/.exec(
        sessionColsSrc
      );
      if (!primary || !defaultSort) {
        throw new Error(
          "could not read the Sessions primary column and default sort"
        );
      }
      for (const [what, key] of [
        ["primary column", primary[1]],
        ["default sort", defaultSort[1]],
      ]) {
        if (!sessionKeys.includes(key)) {
          problems.push(
            `the Sessions ${what} is \`${key}\`, which is not one of its ` +
              "columns — the list would sort on a field no row has, and " +
              "every row would compare equal"
          );
        }
      }
      // And the screen has to actually hand it over. useViewPrefs
      // defaults to the roster's "name", which no session has.
      const tableSrc = stripComments(read("components", "SessionTable.tsx"));
      if (!/useViewPrefs\([\s\S]{0,200}SESSION_DEFAULT_SORT/.test(tableSrc)) {
        problems.push(
          "SessionTable does not pass SESSION_DEFAULT_SORT to useViewPrefs " +
            "— the list would default to sorting on `name`, which a session " +
            "does not have"
        );
      }

      // The record shows the night's facts BY READING THE COLUMNS, not
      // by listing them again. Two hand-written lists is how a field
      // added to one screen goes missing from the other — which is the
      // state the record was reported in, showing three chips of five
      // fields and a line telling you to go and edit them elsewhere.
      const detailSrc = stripComments(read("components", "SessionDetail.tsx"));
      // Both screens build their fields from sessionColumnsFor — the
      // one function that knows which leveling field this campaign
      // uses — so the record and the list cannot drift into offering
      // different fields, and neither can show XP Awarded to a
      // milestone table.
      const tableSrc2 = stripComments(read("components", "SessionTable.tsx"));
      for (const [file, src] of [
        ["SessionDetail.tsx", detailSrc],
        ["SessionTable.tsx", tableSrc2],
      ]) {
        if (!/sessionColumnsFor\(leveling\)/.test(src)) {
          problems.push(
            `${file} does not build its fields from sessionColumnsFor — ` +
              "it would show the same leveling field to every campaign, " +
              "whichever way the campaign levels"
          );
        }
      }

      // Tabs, DM first — which is the way round it was asked for and is
      // not otherwise recoverable: both tabs are the same markup with
      // different props, so swapping them is a silent change that still
      // renders perfectly. They replaced a side-by-side split.
      const tabs = detailSrc.indexOf('className="session-tabs"');
      if (tabs === -1) {
        problems.push(
          "the session's two note pages are not tabs — a split showed a " +
            "second page you were usually not looking at, and left no " +
            "answer to which page a new box went on"
        );
      } else {
        // Anchored on the handlers rather than the labels: the label
        // text sits on its own line inside the button, so a search for
        // ">DM notes" finds nothing and reports the tabs in the wrong
        // order regardless of what order they are in.
        const dmAt = detailSrc.indexOf('setTab("dm")', tabs);
        const playerAt = detailSrc.indexOf('setTab("player")', tabs);
        if (dmAt === -1 || playerAt === -1 || dmAt > playerAt) {
          problems.push("the DM notes are not the first tab");
        }
        for (const label of ["DM notes", "Player notes"]) {
          if (!detailSrc.slice(tabs).includes(label)) {
            problems.push(`the session tabs have no "${label}" tab`);
          }
        }
      }
      if (/session-notes-split/.test(detailSrc)) {
        problems.push(
          "SessionDetail still renders the old side-by-side split"
        );
      }

      // The bar acts on the page below it, so it goes below whatever
      // names that page. Reported the other way round: it sat above the
      // "Player notes" heading, where it read as part of the record.
      const barAt = detailSrc.indexOf("<NotebookFormatBar");
      const canvasAt = detailSrc.indexOf("<BoxCanvas");
      if (barAt === -1 || canvasAt === -1) {
        problems.push("the session record lost its toolbar or its canvas");
      } else if (!(tabs < barAt && barAt < canvasAt)) {
        problems.push(
          "the format toolbar is not between the tabs and the canvas — it " +
            "belongs at the top of the editing area, under the name of the " +
            "page it acts on"
        );
      }

      // A page you click into and type on, which is the whole of the
      // report: adding a text box before you could write a sentence
      // made a page of notes into a layout exercise.
      // `\bpage=` and not `page=`: the prop renamed to `notpage` is
      // still a substring match, and the mutation that did exactly that
      // walked past this check.
      if (!/\bpage=\{\{/.test(detailSrc) || !/pageBoxId\(/.test(detailSrc)) {
        problems.push(
          "the session canvas has no page to write on — the notes would " +
            "again need a text box added before anything could be typed"
        );
      }
      // And the toolbar's saver has to know a page from a box, or a
      // format applied to the page is sent to updateBox with an id that
      // is not a document id.
      if (!/pageSide\(/.test(detailSrc)) {
        problems.push(
          "the format saver does not route by pageSide — an edit to the " +
            "page would be written as if it were a box"
        );
      }

      // Two strings the report named, and one the same report is about:
      // a centred "nothing here yet" over a page you can now type into
      // is both wrong and in the way.
      for (const gone of [
        "Add to notes:",
        "Add to DM notes:",
        "Nothing written down yet",
      ]) {
        if (detailSrc.includes(gone)) {
          problems.push(`SessionDetail still says "${gone}"`);
        }
      }

      const facets = (
        sessionColsSrc.match(/SESSION_FACET_KEYS = \[([^\]]*)\]/s)?.[1] ?? ""
      )
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      for (const key of facets) {
        if (!sessionKeys.includes(key)) {
          problems.push(
            `SESSION_FACET_KEYS names \`${key}\`, which is not a Sessions ` +
              "column — Group by would offer an unlabelled option"
          );
        }
      }
    }

    // Every column needs a default width and visibility, or the layout
    // reconciler produces a column that cannot be sized or shown.
    for (const entry of columnsBlock.split(/\},\s*\n/)) {
      const m = entry.match(/key:\s*"([^"]+)"/);
      if (!m) continue;
      if (!/defaultWidth:/.test(entry)) {
        problems.push(`column \`${m[1]}\` has no defaultWidth`);
      }
      if (!/defaultVisible:/.test(entry)) {
        problems.push(`column \`${m[1]}\` has no defaultVisible`);
      }
    }

    // A column's `kind` must match how the field is actually stored.
    // Getting this wrong is invisible until someone edits: the editor
    // parses by kind, so a scalar declared `chips` sends ["Grung"] into
    // a v.string() field and the mutation rejects it.
    for (const entry of columnsBlock.split(/\},\s*\n/)) {
      const keyMatch = entry.match(/key:\s*"([^"]+)"/);
      const kindMatch = entry.match(/kind:\s*"([^"]+)"/);
      if (!keyMatch || !kindMatch) continue;
      const [key, kind] = [keyMatch[1], kindMatch[1]];

      const decl = npcsBlockSrc.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
      if (!decl) continue; // covered by the dangling-key check above
      const storage = decl[1];
      const isArray = storage.includes("v.array(");

      if (kind === "chips" && !isArray) {
        problems.push(
          `column \`${key}\` is kind "chips" but the schema stores a scalar — ` +
            "editing it would send an array into a string field"
        );
      }
      if (kind !== "chips" && isArray) {
        problems.push(
          `column \`${key}\` is kind "${kind}" but the schema stores an array`
        );
      }
      if (kind === "number" && !storage.includes("v.number(")) {
        problems.push(`column \`${key}\` is kind "number" but the schema is not`);
      }
      if (kind === "boolean" && !storage.includes("v.boolean(")) {
        problems.push(`column \`${key}\` is kind "boolean" but the schema is not`);
      }
    }

    // Facets and quick filters must name real columns.
    const columnKeySet = new Set(columnKeys);
    for (const key of constArrayStrings(colsSrc, "FACET_KEYS", "npcColumns")) {
      if (!columnKeySet.has(key)) {
        problems.push(`FACET_KEYS names \`${key}\`, which is not a column`);
      }
    }

    // Extra sorts address fields directly rather than columns.
    const extraBlock = colsSrc.slice(colsSrc.indexOf("export const EXTRA_SORTS"));
    for (const key of stringProps(
      extraBlock.slice(0, extraBlock.indexOf("];")),
      "key",
      "EXTRA_SORTS"
    )) {
      if (!available.has(key) && !SYSTEM_FIELDS.includes(key)) {
        problems.push(
          `EXTRA_SORTS sorts on \`${key}\`, which npcs.listForCampaign never returns`
        );
      }
    }

    // ---- every NPC field has a place in the record -----------------
    // The record arranges the fields into sections by string key, and
    // the arrangement is editorial — nothing derives it from the column
    // list, so nothing keeps the two in step but this.
    //
    // Both directions matter, and they fail differently. A section
    // naming a key that is no longer a column is a heading with nothing
    // under it. A column no section names still renders — `arrange`
    // sweeps the leftovers into "More" precisely so a new field cannot
    // vanish from every record in the campaign — but landing there is a
    // reminder to file it, not a resting place.
    const sectionsSrc = read("components", "npcSections.ts");
    const sectionKeys = [];
    const sectionsAt = sectionsSrc.indexOf("export const NPC_SECTIONS");
    if (sectionsAt === -1) {
      throw new Error("no NPC_SECTIONS in npcSections.ts");
    }
    for (const m of sectionsSrc
      .slice(sectionsAt)
      .matchAll(/keys:\s*\[([^\]]*)\]/g)) {
      for (const k of m[1].matchAll(/"([^"]+)"/g)) sectionKeys.push(k[1]);
    }
    if (sectionKeys.length === 0) {
      throw new Error("NPC_SECTIONS names no fields — parser out of date?");
    }

    const headerKeys = constArrayStrings(
      sectionsSrc,
      "HEADER_KEYS",
      "npcSections"
    );
    const summaryKeys = constArrayStrings(
      sectionsSrc,
      "SUMMARY_KEYS",
      "npcSections"
    );

    // Fields the record renders in a fixed place rather than in a tab:
    // the notes rail, and the hide switch beside the name. They are
    // "placed" as much as a section's fields are — just not by the
    // template — so they satisfy the no-field-goes-missing rule, and
    // they must NOT also appear in a section or they would render
    // twice.
    const pinnedKeys = constArrayStrings(
      sectionsSrc,
      "NOTES_KEYS",
      "npcSections"
    ).concat(
      // PINNED_KEYS spreads NOTES_KEYS, so only its own literals are
      // readable here; the spread is picked up by the line above.
      [
        ...(sectionsSrc.match(/PINNED_KEYS\s*=\s*\[([^\]]*)\]/)?.[1] ?? "")
          .matchAll(/"([^"]+)"/g),
      ].map((m) => m[1])
    );
    if (pinnedKeys.length === 0) {
      throw new Error("no PINNED_KEYS in npcSections.ts");
    }

    const placed = new Set([...sectionKeys, ...headerKeys, ...pinnedKeys]);
    for (const key of columnKeys) {
      if (!placed.has(key)) {
        problems.push(
          `npcSections gives \`${key}\` no section, so it falls into "More" ` +
            "at the end of every record"
        );
      }
    }
    for (const key of pinnedKeys) {
      if (sectionKeys.includes(key) || headerKeys.includes(key)) {
        problems.push(
          `\`${key}\` is pinned outside the tabs AND placed in a section — ` +
            "the record would render it twice"
        );
      }
    }
    for (const key of [...sectionKeys, ...headerKeys, ...pinnedKeys, ...summaryKeys]) {
      if (!columnKeySet.has(key)) {
        problems.push(
          `npcSections places \`${key}\`, which is not a column — the record ` +
            "would render a heading with nothing under it"
        );
      }
    }
    // The record is two columns, header included.
    //
    // With the header outside the split it spans the full width and the
    // notes start underneath it, reading as a footnote to the record
    // rather than the other half of it.
    //
    // This used to run over two files, because the Templates tab held a
    // miniature of the record that claimed to be WYSIWYG and so had to
    // agree with it. That miniature is gone — edit mode arranges the
    // record on the record — so there is one drawing of this layout and
    // nothing left for it to disagree with.
    {
      const file = "NpcDetail.tsx";
      const src = read("components", file);
      const split = src.indexOf(`className="record-split"`);
      const head = src.indexOf(`className="record-head`);
      if (split === -1 || head === -1) {
        throw new Error(`no record-split or record-head in ${file}`);
      }
      if (head < split) {
        problems.push(
          `${file} puts the record header OUTSIDE record-split, so it spans ` +
            "the full width and the notes column starts below it instead of " +
            "running the full height beside it"
        );
      }
    }

    // Deleting the Templates tab spent the record's only other way to be
    // arranged. That was the right trade while the record itself can be
    // arranged — and a disaster the moment it cannot, because there is
    // now no second screen to fall back to and nothing that would fail:
    // the record would simply render, un-draggable, looking finished.
    //
    // So the pieces edit mode arranges the record WITH are checked to be
    // mounted, by name, from the file that has to mount them.
    {
      const src = read("components", "NpcDetail.tsx");
      for (const piece of [
        "useTemplateEditing",
        "TabStripEditor",
        "ResizeHandles",
        "FieldHideToggle",
      ]) {
        // Imported AND used — an import alone is what a half-finished
        // refactor leaves behind, and it renders nothing.
        const uses = [...src.matchAll(new RegExp(`\\b${piece}\\b`, "g"))].length;
        if (uses < 2) {
          problems.push(
            `NpcDetail does not mount ${piece} — the Templates tab was ` +
              "removed because the record arranges itself, so losing this " +
              "leaves no way to arrange the record at all"
          );
        }
      }
    }

    // And the tab it was removed from must be gone from BOTH lists, not
    // just unrendered. A declared tab with no panel is already caught
    // further down; this catches the other half — a component left on
    // disk that nothing imports, which typecheck is happy with and
    // which is the copy someone edits by mistake a month from now.
    if (exists("components", "NpcTemplateDesigner.tsx")) {
      problems.push(
        "components/NpcTemplateDesigner.tsx is back on disk — the Templates " +
          "tab was removed in favour of arranging the record on the record, " +
          "and a second designer nothing imports is a copy that silently " +
          "drifts"
      );
    }

    // A pinned field is out of the template's hands, so the ONLY thing
    // that renders it is NpcDetail itself. Pinning one and forgetting
    // to draw it is the same silent loss as leaving it out of a
    // section, minus the "More" safety net that catches that case.
    {
      const src = read("components", "NpcDetail.tsx");
      if (!/NOTES_KEYS\.map\(/.test(src)) {
        problems.push(
          "NpcDetail does not render NOTES_KEYS — the notes rail is pinned " +
            "out of the tabs, so nothing else would draw it"
        );
      }
      if (!/record-hide/.test(src)) {
        problems.push(
          "NpcDetail no longer renders the hide switch, which is pinned out " +
            "of the tabs and drawn nowhere else"
        );
      }
      // And it has to stay DM-only: the switch is about who may see the
      // NPC, so offering it to a player is offering them the lever.
      if (!/isDm && hiddenCol/.test(src)) {
        problems.push(
          "the hide switch is not gated on isDm — a player would be offered " +
            "the control that hides NPCs from players"
        );
      }
    }

    // Every editable field needs an editor somewhere in the record.
    // This is not hypothetical: moving `name` and `nickname` into the
    // header rendered them as a heading and a line of text, and the DM
    // silently lost the ability to rename an NPC from its own record.
    // Nothing failed — the field was simply gone as a control.
    //
    // The header's fields are the exception the check has to allow, so
    // it demands they go through the same RecordField the sections use.
    // Rendering one as `{npc.name}` is exactly the regression above.
    // Comments stripped: a comment explaining that `{npc.name}` as a
    // JSX child is forbidden is the rule being written down, not broken.
    // The same thing tripped the "never build a <mark>" guard, which is
    // how that one learned to strip them too.
    const detailSrc = stripComments(read("components", "NpcDetail.tsx"));
    if (!/headerFields\.map\(/.test(detailSrc)) {
      problems.push(
        "NpcDetail no longer maps the header's fields through RecordField — " +
          "a header field rendered as bare text is a field the DM cannot edit"
      );
    }
    for (const key of headerKeys) {
      // The portrait has its own control rather than a text input.
      if (key === "portraitPath") continue;
      // A JSX child, which is a rendered value — not `alt={npc.name}`
      // or a `${npc.name}` inside an aria-label, both of which are the
      // name being USED rather than shown as the field.
      if (new RegExp(`(?<![=$])\\{npc\\.${key}\\}`).test(detailSrc)) {
        problems.push(
          `NpcDetail renders \`${key}\` as bare text, so it is read-only ` +
            "in the record even though the column is editable"
        );
      }
    }

    // A field cannot be in two sections: whichever renders second wins,
    // and editing the loser writes to a control the eye has already
    // scrolled past.
    const seenKey = new Set();
    for (const key of sectionKeys) {
      if (seenKey.has(key)) {
        problems.push(`npcSections places \`${key}\` in more than one section`);
      }
      seenKey.add(key);
    }
    // DM-only fields must be behind a section a player never receives.
    // The server withholds them regardless, so this is about the record
    // not rendering an empty labelled box where a secret used to be.
    const dmKeys = columnsBlock
      .split(/\},\s*\n/)
      .filter((e) => /dmOnly:\s*true/.test(e))
      .map((e) => e.match(/key:\s*"([^"]+)"/)?.[1])
      .filter(Boolean);
    if (dmKeys.length === 0) {
      throw new Error("no dmOnly columns found — parser out of date?");
    }
    const dmSection = sectionsSrc.slice(sectionsSrc.indexOf('id: "dm"'));
    const dmSectionKeys = [
      ...(dmSection.match(/keys:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
        /"([^"]+)"/g
      ),
    ].map((m) => m[1]);
    for (const key of dmKeys) {
      // A pinned field is not in any section by design; the record
      // renders it itself and gates it on isDm there.
      if (pinnedKeys.includes(key)) continue;
      if (!dmSectionKeys.includes(key)) {
        problems.push(
          `\`${key}\` is dmOnly but is not in the record's "DM only" section — ` +
            "a player would see its heading with a permanently empty field"
        );
      }
    }
    for (const key of dmSectionKeys) {
      if (!dmKeys.includes(key)) {
        problems.push(
          `the record's "DM only" section holds \`${key}\`, which is not ` +
            "dmOnly — it is labelled as a secret and is not one"
        );
      }
    }

    // ---- Rules Lawyer quotes; it never paraphrases ------------------
    // The whole claim of this tool is that what it shows you IS the
    // rules text. Three things have to hold for that to stay true, and
    // each fails silently.
    {
      const tool = read("components", "RulesLawyerTool.tsx");
      const snip = read("components", "rulesSnippet.ts");

      // 1. Rules text is document text rendered on a page. The moment
      //    it is turned into markup to add emphasis, a file is being
      //    concatenated into a browser. highlight returns spans and
      //    JSX escapes them.
      for (const [file, src] of [
        ["RulesLawyerTool.tsx", tool],
        ["rulesSnippet.ts", snip],
      ]) {
        if (/dangerouslySetInnerHTML/.test(src)) {
          problems.push(
            `${file} injects rules text as HTML — it is text out of a ` +
              "document, and the highlighter returns spans precisely so it " +
              "never has to be"
          );
        }
      }
      // Comments stripped first: the file explains that it must NOT
      // build a <mark> tag, and failing it for saying so would be the
      // guard punishing the code for documenting itself.
      if (/<mark|<\/mark|innerHTML/.test(stripComments(snip))) {
        problems.push(
          "rulesSnippet builds markup — it must return spans and leave the " +
            "rendering to JSX, which escapes them"
        );
      }

      // 2. A snippet must be a contiguous run of the real text. Joining
      //    matched fragments with an ellipsis would read as a sentence
      //    the document never contained.
      if (!/slice\(from, to\)/.test(snip)) {
        problems.push(
          "rulesSnippet no longer takes a single contiguous slice — a " +
            "snippet stitched from fragments is a sentence the rules do " +
            "not contain"
        );
      }

      // 3. The screen must render the stored text, not a summary of it.
      //    There is nothing on this screen that generates prose, and a
      //    check that says so is what stops one appearing quietly.
      if (!/hit\.text/.test(tool)) {
        problems.push(
          "RulesLawyerTool no longer renders the stored rules text"
        );
      }
      if (/api\.\w+\.(ask|explain|summari)/i.test(tool)) {
        problems.push(
          "RulesLawyerTool calls something that generates prose. That is " +
            "the second slice, and it belongs beside the quoted rule with " +
            "its citations checked — never in place of it"
        );
      }
    }

    // The rules table is derived reference data: imported, never
    // written from the app. A mutation into it would mean the text on
    // screen is no longer the text in the document.
    {
      const lookupSrc = read("convex", "lookup.ts");
      if (/mutation\(/.test(lookupSrc)) {
        problems.push(
          "convex/lookup.ts defines a mutation — the reference library is " +
            "loaded by import and has no write path, which is what makes " +
            "--replace safe"
        );
      }
      for (const fn of ["searchRules", "ruleContext"]) {
        const at = lookupSrc.indexOf(`export const ${fn}`);
        if (at === -1) throw new Error(`no ${fn} in convex/lookup.ts`);
        const body = blockAfter(lookupSrc.slice(at), /handler:/, fn);
        if (!/requireReader\(/.test(body)) {
          problems.push(`lookup.${fn} does not go through requireReader`);
        }
      }
    }

    // ---- notes: sanitised on the server, owned by their author ------
    // Three separate failures, all silent, all in one feature.
    {
      const src = read("convex", "npcs.ts");
      const notesAt = src.indexOf("export const addNote");
      if (notesAt === -1) throw new Error("no addNote in convex/npcs.ts");

      // 1. Sanitising in the editor is a convenience. Sanitising in the
      //    mutation is the guarantee, because a hand-made call never
      //    opens an editor. If this moves client-side, a player can put
      //    a script in the DM's browser.
      for (const fn of ["addNote", "editNote"]) {
        const at = src.indexOf(`export const ${fn}`);
        if (at === -1) throw new Error(`no ${fn} in convex/npcs.ts`);
        const body = blockAfter(src.slice(at), /handler:/, `${fn} handler`);
        if (!/sanitizeNoteHtml\(/.test(body)) {
          problems.push(
            `npcs.${fn} stores a note body without sanitizing it — the body ` +
              "is rendered as HTML in every other member's browser"
          );
        }
      }

      // 2. A note says who wrote it. Anyone but the author being able
      //    to rewrite one would make that attribution a lie.
      for (const fn of ["editNote", "deleteNote"]) {
        const at = src.indexOf(`export const ${fn}`);
        const body = blockAfter(src.slice(at), /handler:/, `${fn} handler`);
        if (!/note\.authorId !== userId/.test(body)) {
          problems.push(
            `npcs.${fn} does not check that the caller wrote the note`
          );
        }
      }

      // 3. The DM channel is filtered server-side, like every other
      //    DM-only thing here. A client-side filter is a devtools
      //    console away from being no filter at all.
      const listAt = src.indexOf("export const listNotes");
      if (listAt === -1) throw new Error("no listNotes in convex/npcs.ts");
      const listBody = blockAfter(src.slice(listAt), /handler:/, "listNotes");
      if (!/isDm \|\| n\.channel === "player"/.test(listBody)) {
        problems.push(
          "npcs.listNotes does not filter the DM channel out server-side — " +
            "a player's browser would receive notes it merely does not render"
        );
      }
      if (!/viewAsPlayer/.test(listBody)) {
        problems.push(
          "npcs.listNotes ignores viewAsPlayer, so previewing as a player " +
            "would still show the DM notes"
        );
      }

      // And the only place a body is rendered as HTML must be reading
      // one that has been through the server.
      for (const [file, source] of sourceFiles("components")) {
        if (!/dangerouslySetInnerHTML/.test(source)) continue;
        if (file.endsWith("NoteThread.tsx")) continue;
        if (!/sanitize|DOMPurify/.test(source)) {
          problems.push(
            `${file} renders raw HTML without any sanitizing in sight — ` +
              "if that string came from a person, it is a script in a browser"
          );
        }
      }
    }

    // ---- the record template is bounded in two places ---------------
    // The designer clamps so the form behaves; saveTemplate clamps
    // because a mutation is a public API and the client's clamp is not
    // a promise about what arrives. The two have to agree on the same
    // numbers, or the designer offers a width the server quietly turns
    // into a different one — a layout that looks right until it is
    // reloaded.
    const tplSrc = read("components", "npcTemplate.ts");

    const num = (src, name, label) => {
      const m = src.match(new RegExp(`${name}\\s*[:=]\\s*(\\d+)`));
      if (!m) throw new Error(`could not read ${name} from ${label}`);
      return Number(m[1]);
    };
    const maxSpan = num(tplSrc, "MAX_SPAN", "npcTemplate.ts");
    const maxTabs = num(tplSrc, "tabs", "npcTemplate TEMPLATE_LIMITS");
    const titleLen = num(tplSrc, "titleLength", "npcTemplate TEMPLATE_LIMITS");

    const saveAt = npcsSrc.indexOf("export const saveTemplate");
    if (saveAt === -1) throw new Error("no saveTemplate in convex/npcs.ts");
    const saveBody = npcsSrc.slice(saveAt);

    if (num(npcsSrc, "MAX_TABS", "convex/npcs.ts") !== maxTabs) {
      problems.push(
        `tab limit disagrees: npcTemplate says ${maxTabs}, convex/npcs.ts ` +
          `says ${num(npcsSrc, "MAX_TABS", "convex/npcs.ts")}`
      );
    }
    if (num(npcsSrc, "MAX_TITLE", "convex/npcs.ts") !== titleLen) {
      problems.push(
        `tab-title length disagrees: npcTemplate says ${titleLen}, ` +
          `convex/npcs.ts says ${num(npcsSrc, "MAX_TITLE", "convex/npcs.ts")}`
      );
    }
    if (!new RegExp(`Math\\.min\\(\\s*${maxSpan}\\s*,`).test(saveBody)) {
      problems.push(
        `saveTemplate does not clamp a span to ${maxSpan} — the designer ` +
          "offers widths the server would store unchanged"
      );
    }
    if (!/requireDm/.test(saveBody.slice(0, saveBody.indexOf("});")))) {
      problems.push(
        "npcs.saveTemplate does not go through requireDm — the record " +
          "layout is campaign-wide, so any member could rearrange everyone's"
      );
    }

    // The template addresses columns by string key, like everything
    // else on this screen. A tab holding a key that is not a column
    // renders nothing and cannot be fixed from the designer, because
    // the designer is built from the same template.
    const tplDefaults = [
      ...tplSrc.matchAll(/key:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    for (const key of tplDefaults) {
      if (!columnKeySet.has(key)) {
        problems.push(
          `npcTemplate.ts names a \`${key}\` field, which is not a column`
        );
      }
    }

    // ---- the Scheduler's two authorities ---------------------------
    // Different from the rest of the app, and worth stating: the DM
    // decides the DAYS, but availability is each person's own. The
    // failure is not a leak — everyone is meant to see everyone's
    // times — it is one member marking another's evening free and the
    // group booking a night somebody cannot make.
    // Read locally: the calendar section further down binds its own
    // copy, and this check runs before it.
    const schedSrc = read("convex", "calendar.ts");
    const setAvailAt = schedSrc.indexOf("export const setAvailability");
    if (setAvailAt === -1) {
      throw new Error("no setAvailability in convex/calendar.ts");
    }
    const setAvailArgs = blockAfter(
      schedSrc.slice(setAvailAt),
      /args:/,
      "setAvailability args"
    );
    if (/userId/.test(setAvailArgs)) {
      problems.push(
        "setAvailability takes a userId as an ARGUMENT — availability is " +
          "each person's own, and the id has to come from the session or " +
          "any member can mark anyone else's evening free"
      );
    }
    const setAvailBody = blockAfter(
      schedSrc.slice(setAvailAt),
      /handler:/,
      "setAvailability handler"
    );
    if (!/requireMember\(/.test(setAvailBody)) {
      problems.push(
        "setAvailability does not go through requireMember — a stranger " +
          "could answer a campaign's poll"
      );
    }
    if (!/const \{\s*userId\s*\}\s*=\s*await requireMember/.test(setAvailBody)) {
      problems.push(
        "setAvailability does not take its userId from requireMember, so " +
          "there is nothing tying the row it writes to the caller"
      );
    }

    // The DM's half. Offering days is not something a player may do.
    for (const fn of ["setWindow", "clearAllAvailability"]) {
      const at = schedSrc.indexOf(`export const ${fn}`);
      if (at === -1) throw new Error(`no ${fn} in convex/calendar.ts`);
      const body = blockAfter(schedSrc.slice(at), /handler:/, `${fn} handler`);
      if (!/requireDm\(/.test(body)) {
        problems.push(`calendar.${fn} does not go through requireDm`);
      }
    }

    // Slots are filtered to the window on the way IN as well as out. A
    // day the DM withdrew leaves everyone's marks on it behind, and
    // counting them would report agreement on a date nobody is being
    // offered any more.
    if (!/live\.has\(/.test(setAvailBody)) {
      problems.push(
        "setAvailability stores whatever slots it is sent — a hand-made " +
          "call could fill the table with keys no grid will ever render"
      );
    }

    // ---- nav slugs must have pages behind them ---------------------
    // The sidebar renders these and the ribbon's `t:` tokens address the
    // same list by id, so a renamed folder is a dead link in two places
    // rather than a compile error in either.
    const navSrc = read("components", "navItems.ts");
    for (const slug of stringProps(navSrc, "slug", "navItems destinations")) {
      if (!exists("app", "campaign", "[campaignId]", slug, "page.tsx")) {
        problems.push(
          `nav links to "${slug}" but app/campaign/[campaignId]/${slug}/page.tsx does not exist`
        );
      }
    }
    // TABLE_ITEM's slug is "" — the campaign's own page. An empty string
    // is invisible to the sweep above, so it is checked by name.
    if (!exists("app", "campaign", "[campaignId]", "page.tsx")) {
      problems.push(
        "navItems has a destination for the campaign itself but " +
          "app/campaign/[campaignId]/page.tsx does not exist"
      );
    }

    // ---- the ribbon's three registries -----------------------------
    // Every ribbon token is a string pointing at a control, and a token
    // whose control has gone is the exact failure normalizeRibbon exists
    // to absorb — silently, by design. That silence is right at runtime
    // and wrong at build time, so the shipped default layout and the
    // renderers are checked here instead.
    const ribbonSrc = read("components", "ribbonRegistry.ts");
    const barSrc = read("components", "RibbonBar.tsx");

    const between = (src, from, to, label) => {
      const a = src.indexOf(from);
      if (a === -1) throw new Error(`could not find ${label}`);
      const b = to ? src.indexOf(to, a) : -1;
      return src.slice(a, b === -1 ? src.length : b);
    };

    const builtinKeys = stringProps(
      between(ribbonSrc, "TOOLBAR_BUILTINS: ToolbarBuiltin[]", "];", "TOOLBAR_BUILTINS"),
      "key",
      "TOOLBAR_BUILTINS"
    );
    const commandIds = stringProps(
      between(ribbonSrc, "TOOLBAR_COMMANDS: ToolbarCommand[]", "];", "TOOLBAR_COMMANDS"),
      "id",
      "TOOLBAR_COMMANDS"
    );
    // Only ids that HAVE a slug: NAV_DESTINATIONS filters the rest out,
    // so a `t:` token naming an unbuilt screen is dropped silently by
    // normalizeRibbon. Checking against every id in the file would wave
    // exactly that through.
    const navIds = [];
    for (const [, body] of navSrc.matchAll(/\{([^{}]*)\}/g)) {
      const id = body.match(/\bid:\s*"([^"]+)"/);
      if (id && /\bslug:\s*"/.test(body)) navIds.push(id[1]);
    }
    if (navIds.length === 0) {
      throw new Error("found no slugged nav ids — parser out of date?");
    }

    // Every nav GROUP must reach the sidebar, or adding one to
    // navItems.ts leaves a section that exists in the data and nowhere
    // on screen.
    //
    // The sidebar is arranged per person now, so the route is no longer
    // "AppShell mentions the group" — AppShell renders whatever the
    // saved layout says. What has to hold instead is that every group
    // is in SIDEBAR_GROUPS, which is what a layout is built from and
    // reconciled against. A group missing from there is missing from
    // everyone's sidebar, including people who never customised it.
    const shellSrc = read("components", "AppShell.tsx");
    const groupsBlock = navSrc.slice(navSrc.indexOf("SIDEBAR_GROUPS"));
    if (!groupsBlock) throw new Error("no SIDEBAR_GROUPS in navItems.ts");

    for (const [, group] of navSrc.matchAll(
      /export const (\w+): NavItem\[\]/g
    )) {
      // The ribbon's registry and the designer's flat list are not
      // sidebar sections; both are built FROM the groups.
      if (group === "NAV_DESTINATIONS" || group === "ALL_NAV_ITEMS") continue;
      if (!groupsBlock.includes(group)) {
        problems.push(
          `navItems exports the ${group} group but SIDEBAR_GROUPS never ` +
            "names it, so it is in nobody's sidebar"
        );
      }
    }

    // An item the sidebar ARRANGES may not also be hard-coded into the
    // shell.
    //
    // Settings shipped in the sidebar twice this way: it became an
    // arrangeable item while the footer kept its own link to it. Both
    // rendered, neither was wrong on its own, and the layout system had
    // no way to know about the second — hiding it in the designer would
    // have removed one of the two.
    //
    // Settings is now deliberately OUT of the arranged set and in the
    // footer, so the check is against membership of ALL_NAV_ITEMS
    // rather than against having a slug at all. A hard-coded link to
    // something the designer cannot touch is the fix, not the bug.
    // Read from ALL_NAV_ITEMS, because that is what AppShell hands to
    // reconcileSidebar — the actual authority on what the sidebar
    // arranges. Reading the group constants instead looked equivalent
    // and was not: adding SETTINGS_ITEM back to ALL_NAV_ITEMS alone
    // re-created the duplicate and the check never noticed.
    const allAt = navSrc.indexOf("export const ALL_NAV_ITEMS");
    if (allAt === -1) throw new Error("no ALL_NAV_ITEMS in navItems.ts");
    const allBody = navSrc.slice(allAt, navSrc.indexOf("];", allAt));

    const slugsOfConst = (name) => {
      const at = navSrc.indexOf(`export const ${name}`);
      if (at === -1) throw new Error(`no ${name} in navItems.ts`);
      const end = navSrc.indexOf(
        navSrc.slice(at).startsWith(`export const ${name}: NavItem =`) ? "};" : "];",
        at
      );
      return [...navSrc.slice(at, end).matchAll(/\bslug:\s*"([^"]+)"/g)].map(
        (m) => m[1]
      );
    };

    const arrangedSlugs = new Set();
    // `...GROUP` spreads a list; a bare `NAME,` names one item.
    for (const m of allBody.matchAll(/\.\.\.(\w+)/g)) {
      for (const slug of slugsOfConst(m[1])) arrangedSlugs.add(slug);
    }
    for (const m of allBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]*),\s*$/gm)) {
      for (const slug of slugsOfConst(m[1])) arrangedSlugs.add(slug);
    }
    if (arrangedSlugs.size === 0) {
      throw new Error("no arranged slugs found — parser out of date?");
    }
    for (const slug of arrangedSlugs) {
      if (shellSrc.includes("${base}/" + slug)) {
        problems.push(
          `AppShell hard-codes a link to "${slug}", which the sidebar layout ` +
            "also renders — it would appear twice, and hiding it would " +
            "remove only one of them"
        );
      }
    }

    // ---- a group that becomes real keeps the screen looking at it ---
    // Half the Groups list is not documents: a name some NPCs carry,
    // keyed by that name. The first thing you type into one creates the
    // document, and its identity moves with it — name key to id — while
    // the list is still holding the old one. Nothing about that is
    // visible in a type: both are strings, `find` simply returns
    // undefined, and the record you were typing into closes itself
    // mid-word.
    {
      const detail = stripComments(read("components", "GroupDetail.tsx"));
      const table = stripComments(read("components", "GroupTable.tsx"));

      const at = detail.indexOf("const ensure =");
      if (at === -1) {
        problems.push(
          "GroupDetail has no ensure() — creating the document on first " +
            "edit is how an undescribed group is written up at all"
        );
      } else {
        const body = detail.slice(at, detail.indexOf("\n  const run", at));
        if (!/onBecameReal\(/.test(body)) {
          problems.push(
            "GroupDetail's ensure() creates the document without telling " +
              "the list — the row's key changes from its name to its id, " +
              "and the open record would close itself mid-edit"
          );
        }
      }
      if (!/onBecameReal=\{/.test(table)) {
        problems.push(
          "GroupTable does not pass onBecameReal, so GroupDetail cannot " +
            "report a group it had to create"
        );
      }

      // And the same handoff on the grid's own inline edit.
      const commitAt = table.indexOf("async function commitEdit");
      if (commitAt === -1) {
        problems.push("no commitEdit in GroupTable.tsx");
      } else {
        const body = table.slice(commitAt, table.indexOf("\n  /**", commitAt));
        if (!/if \(!row\.groupId\)/.test(body)) {
          problems.push(
            "GroupTable's commitEdit does not follow the id a row gains " +
              "on its first edit — the selection would still name the row " +
              "by a key nothing answers to any more"
          );
        }
      }
    }

    // ---- every list opens a row the same way, in the same place -----
    // The Lookup tabs used to open a row from a `+` at the far right,
    // so the control was on the opposite side of the screen from the
    // name you had just read. One gesture now, at the head of the row,
    // in both lists — which is only true if it is the same drawing, the
    // same class, and the same width, and nothing in the type system
    // holds any of those three together.
    {
      const npc = stripComments(read("components", "NpcTable.tsx"));
      const lookup = stripComments(read("components", "LookupTool.tsx"));

      // One drawing. A second copy is how the two quietly diverge.
      // Both icons, and every list file — a copy of either drawing is
      // how two lists quietly diverge. The check that only watched
      // ExpandIcon let a mutant draw a second CaretIcon unremarked.
      for (const icon of ["ExpandIcon", "CaretIcon"]) {
        const drawn = [
          ["ExpandIcon.tsx", read("components", "ExpandIcon.tsx")],
          ["NpcTable.tsx", npc],
          ["LookupTool.tsx", lookup],
          ["SessionTable.tsx", stripComments(read("components", "SessionTable.tsx"))],
          ["GroupTable.tsx", stripComments(read("components", "GroupTable.tsx"))],
        ].filter(([, src]) =>
          new RegExp(`function ${icon}\\d*\\(`).test(src)
        );
        if (drawn.length !== 1 || drawn[0][0] !== "ExpandIcon.tsx") {
          problems.push(
            `${icon} is drawn in ` +
              (drawn.map(([f]) => f).join(" and ") || "no file") +
              " — it belongs in ExpandIcon.tsx alone, so the lists " +
              "cannot end up wearing different icons for the same gesture"
          );
        }
      }

      // One control, and in the Lookup row it comes BEFORE the columns.
      // A row's cells are laid out in source order against the grid
      // template, so a button that drifts below the map is a button
      // back on the right-hand edge.
      for (const [file, src] of [
        ["NpcTable.tsx", npc],
        ["LookupTool.tsx", lookup],
      ]) {
        if (!/className="expand-btn"/.test(src)) {
          problems.push(
            `${file} has no expand-btn — its rows would have no visible ` +
              "way in, which is the state the NPC list was reported in"
          );
        }
      }

      // WHICH icon the button wears is meaning, not decoration, and it
      // was reported when it lied: ExpandIcon promises a window, so a
      // row that reveals its entry IN PLACE wears the caret instead.
      // The three record lists open a full-screen record; Lookup does
      // not.
      const sessions = stripComments(read("components", "SessionTable.tsx"));
      const groups = stripComments(read("components", "GroupTable.tsx"));
      for (const [file, src] of [
        ["NpcTable.tsx", npc],
        ["SessionTable.tsx", sessions],
        ["GroupTable.tsx", groups],
      ]) {
        if (!/<ExpandIcon\s*\/>/.test(src)) {
          problems.push(
            `${file} does not wear ExpandIcon — its rows replace the ` +
              "screen, which is that icon's one meaning"
          );
        }
        if (/<CaretIcon\b/.test(src)) {
          problems.push(
            `${file} wears the caret — but its rows open a full record, ` +
              "and the caret promises a reveal under the row"
          );
        }
      }
      if (!/<CaretIcon open=\{isOpen\}\s*\/>/.test(lookup)) {
        problems.push(
          "LookupTool's rows do not wear CaretIcon — they reveal in " +
            "place, and ExpandIcon there promises a window it never opens"
        );
      }
      if (/<ExpandIcon\b/.test(lookup)) {
        problems.push(
          "LookupTool still renders ExpandIcon somewhere — the reveal " +
            "gesture and the open-a-window gesture must not share a symbol"
        );
      }
      if (!/export function CaretIcon\(/.test(read("components", "ExpandIcon.tsx"))) {
        problems.push(
          "CaretIcon is not drawn in ExpandIcon.tsx beside its sibling — " +
            "the pair are one decision and drift apart in separate files"
        );
      }
      const rowAt = lookup.indexOf('className="lk-tr"');
      if (rowAt === -1) {
        problems.push("no lk-tr in LookupTool — the row markup moved");
      } else {
        const button = lookup.indexOf('className="expand-btn"', rowAt);
        const cells = lookup.indexOf("columns.map(", rowAt);
        if (button === -1 || cells === -1 || button > cells) {
          problems.push(
            "the Lookup row's expand button is not the first thing in the " +
              "row — it would sit after the columns again, which is the " +
              "right-hand edge it was moved off"
          );
        }
      }

      // One width. The grid template's leading track is a string in a
      // .ts module; the NPC table's is a number in a .tsx one.
      const track = /EXPAND_TRACK = "(\d+)px"/.exec(
        read("components", "lookupFields.ts")
      );
      const col = /EXPAND_COL = (\d+)/.exec(npc);
      if (!track || !col) {
        throw new Error("could not read both expand-column widths");
      }
      if (track[1] !== col[1]) {
        problems.push(
          `the two lists' expand columns are ${track[1]}px and ${col[1]}px — ` +
            "they open the same way in the same place, so their names " +
            "should start on the same line"
        );
      }
    }

    // ---- the list's panels float, and every float can be dismissed --
    // Filter, Group, Sort and Fields hang under their own button. Two
    // ways that regresses, and only one of them is visible:
    //
    //   back into the flow  — the table jumps down the page when you
    //                         open one. Obvious, and reported once.
    //   without a scrim     — the panel opens and nothing closes it
    //                         but the button that opened it. Quiet,
    //                         and the thing people actually get stuck
    //                         on.
    {
      // A panel rendered as a block in the screen's own flow. Checked
      // on the SCREENS, because that is where a panel would land if
      // somebody pulled one back out of its button.
      for (const file of ["NpcTable.tsx", "GroupTable.tsx"]) {
        const screen = stripComments(read("components", file));
        for (const m of screen.matchAll(/\{panel === "(\w+)" && \(/g)) {
          problems.push(
            `${file}'s ${m[1]} panel is rendered in the screen's flow — ` +
              "opening it would push the whole table down the page. It " +
              "belongs under its button, inside a bar-pop"
          );
        }
      }

      // And the floating itself, in the toolbar both screens wear.
      const src = stripComments(read("components", "TableToolbar.tsx"));

      // Every floating panel needs something to dismiss it. Checked
      // pairwise: each bar-panel must have a scrim within the same
      // conditional block above it.
      const panels = [...src.matchAll(/className="bar-panel"/g)];
      if (panels.length === 0) {
        problems.push(
          "no bar-panel in TableToolbar — the toolbar's panels are meant " +
            "to float under their buttons"
        );
      }
      for (const m of panels) {
        const before = src.slice(Math.max(0, m.index - 300), m.index);
        if (!/className="view-scrim"/.test(before)) {
          problems.push(
            "a bar-panel is rendered with no view-scrim above it — " +
              "clicking outside it would not close it, and the only way " +
              "out would be the button that opened it"
          );
        }
      }

      // And the scrim has to actually do something.
      for (const m of src.matchAll(/className="view-scrim"([^>]*)>/g)) {
        if (!/onClick=/.test(m[1])) {
          problems.push(
            "a view-scrim has no onClick — it would swallow the click " +
              "that was meant to dismiss the panel and close nothing, " +
              "which is worse than not being there"
          );
        }
      }
    }

    // ---- no row is fetched for a parent that has no row ------------
    // An inferred parent's id is synthetic. Sending one to a getter is
    // an ArgumentValidationError from Convex, which reaches the
    // browser as a red overlay rather than as an empty result.
    //
    // The gate used to be written per kind, and only the classes query
    // had it — because classes were the only kind with inferred
    // parents when it was written. The day species grew them too, the
    // species query fetched `absent:(vrgtr)` and the tab crashed. So
    // the rule is that EVERY getter is gated, checked against
    // convex/lookup.ts's own list of them rather than a list here.
    {
      const src = stripComments(read("components", "LookupTool.tsx"));
      const at = src.indexOf("function ExpandedRow");
      if (at === -1) throw new Error("no ExpandedRow in LookupTool.tsx");
      const body = src.slice(at, src.indexOf("\nfunction ", at + 1));

      const getters = [
        ...read("convex", "lookup.ts").matchAll(
          /export const (get\w+) = query/g
        ),
      ].map((m) => m[1]);
      if (getters.length === 0) {
        throw new Error("read no getters out of convex/lookup.ts");
      }

      for (const getter of getters) {
        const call = body.indexOf(`api.lookup.${getter},`);
        if (call === -1) {
          problems.push(
            `ExpandedRow never calls ${getter} — that kind's rows would ` +
              "open onto nothing"
          );
          continue;
        }
        // The condition is the rest of that useQuery call, up to the
        // "skip" that ends it.
        const arg = body.slice(call, body.indexOf('"skip"', call));
        if (!/\bon\(/.test(arg)) {
          problems.push(
            `ExpandedRow's ${getter} call does not go through the shared ` +
              "guard — an inferred parent's synthetic id would be sent to " +
              "Convex and the tab would crash"
          );
        }
      }

      // The "no entry for the class itself" note is a CLASSES note.
      // On species every heading has no entry by design — the printings
      // are all variants underneath it — so the note would be telling
      // you something is missing when nothing is. It was, and was
      // reported.
      const noteAt = body.indexOf("lk-inferred");
      if (noteAt === -1) {
        problems.push(
          "the inferred-parent note is gone from ExpandedRow — on the " +
            "classes tab a heading with no entry is a gap worth explaining"
        );
      } else {
        const before = body.slice(Math.max(0, noteAt - 200), noteAt);
        if (!/kind === "classes" && \(/.test(before)) {
          problems.push(
            "the inferred-parent note is not gated to the classes tab — " +
              "on species it announces missing data that is not missing"
          );
        }
      }

      // And the guard itself has to still be the one thing it is.
      if (!/const real = !id\.startsWith\(ABSENT_PARENT_ID\)/.test(body)) {
        problems.push(
          "ExpandedRow no longer derives `real` from ABSENT_PARENT_ID — " +
            "the sentinel and the check have to agree, and nothing else " +
            "connects them"
        );
      }
      if (!/const on = \(want: LookupKind\) => kind === want && real/.test(body)) {
        problems.push(
          "ExpandedRow's `on` no longer folds in `real` — every getter " +
            "would be gated on the kind alone, which is the bug this " +
            "check exists for"
        );
      }
    }

    // ---- a subclass row opens BESIDE its button, not inside it -----
    // The same parser trap the UiText check above is about, one screen
    // over. A subclass's entry contains buttons of its own — the
    // artwork opens a lightbox — so rendering it inside the row's own
    // <button> would have the parser close that button early, React
    // hydrate a different tree than it rendered, and the page come
    // back subtly wrong rather than erroring.
    {
      const src = stripComments(read("components", "LookupTool.tsx"));
      const at = src.indexOf("function FamilyRow");
      if (at === -1) {
        throw new Error("no FamilyRow in LookupTool.tsx — has it moved?");
      }
      const body = src.slice(at, src.indexOf("\nfunction ", at + 1));

      const headOpen = body.indexOf('className="lk-subrow-head"');
      const headClose = body.indexOf("</button>", headOpen);
      const entry = body.indexOf("<ExpandedRow");
      if (headOpen === -1 || headClose === -1) {
        throw new Error("could not read FamilyRow's head button");
      }
      if (entry === -1) {
        problems.push(
          "FamilyRow no longer renders ExpandedRow — the caret would " +
            "open onto nothing, which is a list that pretends to expand"
        );
      } else if (entry < headClose) {
        problems.push(
          "FamilyRow renders the entry INSIDE its head button — the " +
            "entry has buttons of its own, so the parser restructures the " +
            "tree and hydration comes back wrong"
        );
      }
    }

    // ---- a filter must read its value the shape it is stored in ----
    // FilterValue is a union, and every `match` casts to whichever
    // member it believes it has. A cast is an assertion, not a check,
    // so believing wrong compiles perfectly and then throws at the
    // first click — "wanted.some is not a function", which unmounts
    // the whole Lookup screen behind a red overlay.
    //
    // The control decides the shape. `chips` is exclusive and stores
    // ONE string; `multi` stores an array. So a chips filter casting
    // to string[] is the bug, stated as a rule.
    {
      const src = read("components", "lookupFilters.ts");
      // Each FilterDef is `{ ... control: {...}, ... match: ... }`.
      // Split on `key:` at a filter's indent and read each one whole.
      const defs = src.split(/\n  \{\n/).slice(1);
      for (const def of defs) {
        const body = def.slice(0, def.indexOf("\n  },"));
        if (!/control:\s*\{\s*type:\s*"(\w+)"/.test(body)) continue;
        const type = /control:\s*\{\s*type:\s*"(\w+)"/.exec(body)[1];
        const key = /key:\s*"([^"]+)"/.exec(body)?.[1] ?? "(unnamed)";
        const match = body.slice(body.indexOf("match:"));
        if (!match) continue;

        if (type === "chips" && /as string\[\]/.test(match)) {
          problems.push(
            `the "${key}" filter is a chips control — its value is ONE ` +
              "string — but its match casts to string[]. That compiles and " +
              "throws on the first click, taking the screen down"
          );
        }
        if (type === "multi" && /as string(?!\[)/.test(match)) {
          problems.push(
            `the "${key}" filter is a multi control — its value is an ` +
              "ARRAY — but its match casts to a single string, so it would " +
              "silently match nothing"
          );
        }
        if (type === "range" && !/min:\s*string/.test(match)) {
          problems.push(
            `the "${key}" filter is a range control but its match does not ` +
              "read a {min,max} — it would compare against an object"
          );
        }
      }
    }

    // ---- a cell that links must land somewhere that listens --------
    // `linksTo` on a column is a string, matched against a string in
    // NpcTable's openLink, pointing at a screen that has to READ the
    // parameter it is sent. Three places, no types between them, and
    // every way it breaks is silent: a chip that does nothing when
    // clicked, or one that navigates to an unfiltered list — which
    // reads as the link being broken rather than as the destination
    // ignoring it.
    {
      const columnsSrc = stripComments(read("components", "npcColumns.ts"));
      const tableSrc = read("components", "NpcTable.tsx");

      const declared = [
        ...columnsSrc.matchAll(/linksTo:\s*"(\w+)"/g),
      ].map((m) => m[1]);
      if (declared.length === 0) {
        throw new Error("no linksTo columns found — parser out of date?");
      }

      const linkAt = tableSrc.indexOf("const openLink =");
      if (linkAt === -1) {
        throw new Error("no openLink in NpcTable.tsx");
      }
      const linkBody = tableSrc.slice(
        linkAt,
        tableSrc.indexOf("\n  if (result === undefined", linkAt)
      );

      // Which screen each kind is sent to, and what has to be true
      // there. `npc` is handled inside this screen. Species lives on
      // the Lookup screen's species TAB now, not on a route of its own
      // — so the link is /lookup?tab=species&open=… and the route it
      // has to reach is the lookup page.
      const DESTINATIONS = {
        species: ["app", "campaign", "[campaignId]", "lookup", "page.tsx"],
        location: ["app", "campaign", "[campaignId]", "locations", "page.tsx"],
        group: ["app", "campaign", "[campaignId]", "groups", "page.tsx"],
      };
      const READERS = {
        species: "LookupTool.tsx",
        location: "LocationsTool.tsx",
        group: "GroupTable.tsx",
      };

      for (const kind of new Set(declared)) {
        if (!linkBody.includes(`"${kind}"`)) {
          problems.push(
            `a column declares linksTo: "${kind}", which openLink has no ` +
              "arm for — clicking that value would do nothing at all"
          );
        }
        const route = DESTINATIONS[kind];
        if (route && !exists(...route)) {
          problems.push(
            `linksTo: "${kind}" navigates to a route that does not exist`
          );
        }
        const reader = READERS[kind];
        if (reader) {
          const src = read("components", reader);
          if (!/params\.get\("open"\)/.test(src)) {
            problems.push(
              `${reader} does not read the \`open\` parameter, so a ` +
                `linksTo: "${kind}" chip would navigate there and land on ` +
                "an ordinary list — which reads as the link being broken"
            );
          }
        }
      }

      // And the one way in must stay the one way in. A cell that opens
      // the record puts back the invisible second control the expand
      // button replaced — and on a linking column it would fight the
      // link for the same click.
      const rowAt = tableSrc.indexOf("function Row({");
      if (rowAt === -1) throw new Error("no Row in NpcTable.tsx");
      const rowBody = tableSrc.slice(rowAt);
      for (const m of rowBody.matchAll(/onClick=\{onOpen\}/g)) {
        // The expand button is the legitimate one; anything else is a
        // cell that opens the record.
        const before = rowBody.slice(Math.max(0, m.index - 400), m.index);
        if (!/className="expand-btn"/.test(before)) {
          problems.push(
            "a cell in Row still opens the record on click — the expand " +
              "button is meant to be the only way in, and on a linking " +
              "column the two would race for the same click"
          );
        }
      }
    }

    // ---- a column that reads its own width is asked for it ---------
    // The Source column shows a book's NAME where the space allows and
    // its abbreviation where it does not, which only works if the cell
    // is told how wide it is. Two ways that stops: the column loses its
    // `fit`, or the renderer stops calling it — and both look like a
    // column that has quietly gone back to abbreviations, which is what
    // it showed before anybody asked.
    {
      const fieldsSrc = read("components", "lookupFields.ts");
      const toolSrc = stripComments(read("components", "LookupTool.tsx"));

      if (!/fit:\s*\(r, widthPx\)/.test(fieldsSrc)) {
        problems.push(
          "no column reads its own width any more — the Source column " +
            "is meant to fall back to an abbreviation where the name " +
            "does not fit"
        );
      }
      if (!/const cellText =/.test(toolSrc)) {
        problems.push(
          "LookupTool has no cellText, so a column's `fit` is never " +
            "called and the width rule does nothing"
        );
      } else if (!/\{cellText\(c, row\)\}/.test(toolSrc)) {
        problems.push(
          "the table draws its cells without going through cellText — " +
            "a column that reads its own width would be drawn as if it " +
            "had none"
        );
      }
    }

    // ---- a drawn nav icon must have a drawing ----------------------
    // `art: "people"` names a component in NavIcon.tsx, by string.
    // Getting it wrong does not throw and does not render nothing: the
    // component falls back to the CHARACTER, so the icon is simply the
    // old one and the change looks like it did not take. Which is the
    // whole failure — you go back and edit navItems.ts again.
    {
      const iconSrc = read("components", "NavIcon.tsx");
      const artBlock = blockAfter(
        iconSrc,
        /const ART: Record<string, \(\) => React\.JSX\.Element> =/,
        "the ART map in NavIcon.tsx"
      );
      const drawn = [...artBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      if (drawn.length === 0) {
        throw new Error("read no drawings out of NavIcon's ART map");
      }

      const asked = [...navSrc.matchAll(/\bart:\s*"([^"]+)"/g)].map(
        (m) => m[1]
      );
      for (const name of asked) {
        if (!drawn.includes(name)) {
          problems.push(
            `a nav item asks for the drawn icon "${name}", which NavIcon's ` +
              "ART map does not have — it would fall back to the character " +
              "and look like the icon simply never changed"
          );
        }
      }
      // And the other direction: a drawing nothing asks for is dead
      // code that looks like a working feature.
      for (const name of drawn) {
        if (!asked.includes(name)) {
          problems.push(
            `NavIcon draws "${name}" and no nav item asks for it — either ` +
              "an item lost its `art` key or the drawing is unused"
          );
        }
      }

      // Every drawing goes through Glyph, which owns the viewBox and the
      // stroke. A drawing that brings its own <svg> renders perfectly
      // and is simply the wrong weight beside the others — the sidebar
      // reads as a set or it does not, and nothing else in the
      // toolchain has an opinion about that. The people icon was the
      // odd one out for exactly as long as it was the only drawing.
      const svgs = [...iconSrc.matchAll(/<svg\b/g)].length;
      if (svgs !== 1) {
        problems.push(
          `NavIcon.tsx has ${svgs} <svg> elements — there should be one, ` +
            "inside Glyph, so every drawing is framed and stroked the same"
        );
      }
      for (const m of iconSrc.matchAll(/function (\w+Icon)\(\)[\s\S]{0,120}?\{/g)) {
        const at = m.index;
        const body = iconSrc.slice(at, iconSrc.indexOf("\n}", at));
        if (!/<Glyph>/.test(body)) {
          problems.push(
            `NavIcon's ${m[1]} does not draw inside Glyph — it would carry ` +
              "its own viewBox and stroke, and sit at a different weight " +
              "from every other icon in the sidebar"
          );
        }
      }
      // Every site that renders an item's icon has to go through
      // NavIcon, or the drawing appears in one place and the old
      // character in the others.
      for (const [file, source] of sourceFiles("components")) {
        if (file.endsWith("NavIcon.tsx")) continue;
        // The CHILD position — `<span …>{item.icon}</span>` — and not
        // the prop that fixes it, which is the same three tokens with
        // an `icon=` in front and was what this first flagged.
        if (/>\s*\{\s*(?:item|nav|tool)\.icon\s*\}/.test(source)) {
          problems.push(
            `${file} renders a nav item's \`icon\` directly instead of ` +
              "through NavIcon — an item with a drawn icon would show the " +
              "character there and the drawing everywhere else"
          );
        }
      }
    }

    // The way out of a preview must not be gated on not being in one.
    //
    // View as Player turns isDm off so the DM-only screens go away —
    // which is the point. But the switch that turns it back off lives
    // in the same sidebar, and hanging it off the same isDm would make
    // it a one-way door: the button disappears the instant it works,
    // and the only way back is Settings, which is also filtered.
    //
    // So the switch reads the STRUCTURAL fact (you run this campaign),
    // and only the nav filter reads the previewing-adjusted one.
    if (/viewAsPlayer/.test(shellSrc)) {
      if (!/runsThis && \(/.test(shellSrc)) {
        problems.push(
          "the View as Player switch is not gated on the structural DM " +
            "check — if it hangs off the previewing-adjusted isDm it " +
            "vanishes the moment it is used, with no way back"
        );
      }
      if (!/const isDm = runsThis && !previewing/.test(shellSrc)) {
        problems.push(
          "AppShell does not fold viewAsPlayer into the isDm it filters " +
            "the sidebar with, so previewing would leave the DM-only " +
            "screens on screen"
        );
      }

      // The same door, checked at the level below. The switch is a
      // segmented pair now, and BOTH halves have to be on screen
      // whenever you run the campaign — the previewing state may decide
      // which is marked, never which exists. Gate the DM option on
      // being in a preview and the way out is a button you have to
      // already be somewhere else to see.
      const at = shellSrc.indexOf('className="view-as"');
      if (at === -1) {
        problems.push(
          "no view-as switch in AppShell — a DM who previews as a player " +
            "would have no way back short of Settings, which the preview " +
            "also filters"
        );
      } else {
        const block = shellSrc.slice(at, shellSrc.indexOf("</div>", at));
        const opts = [...block.matchAll(/className=\{`view-as-opt/g)].length;
        if (opts !== 2) {
          problems.push(
            `the view-as switch draws ${opts} options — it is DM and ` +
              "Player, both always present, with the current one marked"
          );
        }
        if (/\bpreviewing &&\s*\(?\s*</.test(block) || /!previewing &&\s*\(?\s*</.test(block)) {
          problems.push(
            "one of the view-as options is only rendered in one of the " +
              "two states — that is the one-way door again, wearing a " +
              "segmented control's clothes"
          );
        }
      }
    }

    // ---- there is always a way out of a campaign -------------------
    // The sidebar is the only navigation in the app, and every link in
    // it goes further IN. "All campaigns" used to sit in the footer and
    // was moved to a back button beside the campaign name — leaving is
    // not a place. If that button ever goes, a campaign becomes a room
    // with no door: the browser's own back button still works, which is
    // exactly why nothing on screen would look broken.
    {
      const outward = [...shellSrc.matchAll(/href="\/"/g)].length;
      if (outward === 0) {
        problems.push(
          "the sidebar has no link out to the campaign list — every other " +
            "link in it goes further into this campaign, so there would be " +
            "no way back that is on the screen"
        );
      }
    }

    // ---- a section heading outranks the items under it --------------
    // Reported: the titles read as captions on the item above rather
    // than as the top of a group, because they were set SMALLER and
    // lighter than their own contents. The relationship is the fix, so
    // the relationship is what is checked — two numbers in one
    // stylesheet with nothing but this connecting them.
    {
      const css = read("app", "globals.css");
      const sizeOf = (selector) => {
        const at = css.indexOf(`${selector} {`);
        if (at === -1) throw new Error(`no ${selector} rule in globals.css`);
        const m = /font-size:\s*([\d.]+)rem/.exec(
          css.slice(at, css.indexOf("}", at))
        );
        if (!m) throw new Error(`no font-size on ${selector}`);
        return Number(m[1]);
      };
      const title = sizeOf(".nav-group-title");
      const item = sizeOf(".nav-item");
      // Not-smaller, rather than larger. The reported defect was a
      // heading set BELOW its own contents, which reads as a caption on
      // the row above; equal size with bold and capitals is where Derek
      // settled, and a guard demanding larger would have refused it.
      if (title < item) {
        problems.push(
          `a sidebar section title is ${title}rem and the items under it ` +
            `are ${item}rem — a heading set smaller than its own contents ` +
            "reads as a caption on the row above it"
        );
      }
      // The caret is the section title's one control, so it does not
      // shrink with the words.
      const caret = sizeOf(".nav-fold");
      if (caret < title) {
        problems.push(
          `the sidebar's fold caret is ${caret}rem against a ${title}rem ` +
            "title — at or below text size it reads as punctuation rather " +
            "than as the thing you click"
        );
      }
      const titleBlock = css.slice(
        css.indexOf(".nav-group-title {"),
        css.indexOf("}", css.indexOf(".nav-group-title {"))
      );
      if (!/font-weight:\s*(6|7|8|9)\d\d/.test(titleBlock)) {
        problems.push(
          "a sidebar section title is not bold — size alone does not " +
            "separate a heading from a row when both are the same colour"
        );
      }
    }

    // And the sidebar has to be built from the person's layout rather
    // than from the groups directly, or arranging it does nothing.
    if (!/visibleSidebar\(/.test(shellSrc)) {
      problems.push(
        "AppShell no longer renders through visibleSidebar — the saved " +
          "sidebar layout would be stored and ignored"
      );
    }
    // A DM-only SECTION is filtered on the same preview-adjusted flag
    // as the DM-only items. Handing visibleSidebar the structural
    // runsThis instead would type-check perfectly and leave the DM's
    // prep section standing in the preview that exists to show what a
    // player sees — the one place its absence is the entire point.
    if (!/visibleSidebar\(layout, allowed, isDm\)/.test(shellSrc)) {
      problems.push(
        "AppShell does not pass the previewing-adjusted isDm to " +
          "visibleSidebar — a DM-only section would survive View as Player"
      );
    }
    // Folding writes through to the saved layout. Component state would
    // type-check and would reset on every navigation, because there is
    // no shared layout above these screens and the shell remounts.
    if (/collapsed/.test(shellSrc) && !/saveSettings\(\{ sidebar:/.test(shellSrc)) {
      problems.push(
        "AppShell folds sections without writing the layout back — a fold " +
          "kept in component state springs open on the next navigation"
      );
    }
    // ALL_NAV_ITEMS is what reconcile is given as the full set. If the
    // sidebar were reconciled against a narrower list, an item missing
    // from it would be dropped rather than appended, which is the one
    // way a screen becomes unreachable with no way to notice.
    if (!/reconcileSidebar\([\s\S]{0,200}ALL_NAV_ITEMS/.test(shellSrc)) {
      problems.push(
        "AppShell does not reconcile the sidebar against ALL_NAV_ITEMS — " +
          "an item outside whatever list it uses would be silently dropped"
      );
    }

    // A builtin is drawn by a switch arm keyed on its string. Add one to
    // the registry and forget the arm and the palette offers a button
    // that renders nothing.
    const renderArms = [
      ...between(barSrc, "const renderBuiltin", "if (!tokens)", "renderBuiltin")
        .matchAll(/case "([^"]+)":/g),
    ].map((m) => m[1]);
    for (const key of builtinKeys) {
      if (!renderArms.includes(key)) {
        problems.push(
          `builtin \`${key}\` has no arm in RibbonBar's renderBuiltin — it ` +
            "would render nothing"
        );
      }
    }
    for (const key of renderArms) {
      if (!builtinKeys.includes(key)) {
        problems.push(
          `RibbonBar renders a \`${key}\` builtin that TOOLBAR_BUILTINS does ` +
            "not define, so no token can ever reach it"
        );
      }
    }

    // Same for commands, whose arm is an `if` on the id.
    const runBody = between(barSrc, "const run = useCallback", "const setTheme", "run()");
    for (const id of commandIds) {
      if (!runBody.includes(`"${id}"`)) {
        problems.push(
          `command \`${id}\` has no arm in RibbonBar's run() — the button ` +
            "would do nothing"
        );
      }
    }

    // The default layout has to be made of tokens that resolve today.
    const defaults = [
      ...between(ribbonSrc, "DEFAULT_RIBBON", "];", "DEFAULT_RIBBON").matchAll(
        /"([^"]+)"/g
      ),
    ].map((m) => m[1]);
    if (defaults.length === 0) {
      throw new Error("DEFAULT_RIBBON is empty — parser out of date?");
    }
    const known = { "b:": builtinKeys, "c:": commandIds, "t:": navIds };
    for (const raw of defaults) {
      const tok = raw.startsWith("2!") ? raw.slice(2) : raw;
      const list = known[tok.slice(0, 2)];
      if (list && !list.includes(tok.slice(2))) {
        problems.push(
          `DEFAULT_RIBBON contains "${raw}", which no registry defines — ` +
            "normalizeRibbon would silently drop it from every new toolbar"
        );
      }
    }

    // The ribbon belongs to the DM Screen and nowhere else — that is
    // what the feedback asked for, and it is an ABSENCE, which is the
    // one shape you cannot check by reading the files you thought of.
    const mounts = sourceFiles("components", "app")
      .filter(([rel]) => !rel.endsWith("/RibbonBar.tsx"))
      .filter(([, src]) => /<RibbonBar\b/.test(stripComments(src)))
      .map(([rel]) => rel);
    if (mounts.length !== 1 || !mounts[0].endsWith("/DmScreen.tsx")) {
      problems.push(
        `RibbonBar is rendered in ${mounts.length ? mounts.join(", ") : "nowhere"} — ` +
          "it belongs on the DM Screen and nowhere else"
      );
    }

    // WebKit refuses to START a drag without data on the transfer, so
    // the Customize window looks perfect in a browser and is stone dead
    // in a packaged desktop window on macOS.
    const dnd = stripComments(read("components", "DndColumns.tsx"));
    if (!/dataTransfer\.setData\(/.test(dnd)) {
      problems.push(
        "DndColumns never calls dataTransfer.setData() — dragging would " +
          "not start at all in WebKit"
      );
    }

    // ---- the importers write fields the schema must accept ---------
    // Two of them now — the Airtable CSV and the Foundry export — and
    // both write field names that only the deployed schema validates,
    // i.e. at import time, on real data.
    const foundrySrc = read("scripts", "import-foundry.mjs");

    // Each row builder writes into a different table, and every one of
    // them writes field names that only the deployed schema validates —
    // i.e. at import time, on real data, after the conversion has run.
    const IMPORTERS = [
      { file: "import-npcs.mjs", fn: "const doc", table: "npcs" },
      { file: "import-foundry.mjs", fn: "function actorToNpc", table: "npcs" },
      { file: "import-foundry.mjs", fn: "function itemToRow", table: "items" },
      { file: "import-foundry.mjs", fn: "function spellToRow", table: "spells" },
      {
        file: "import-foundry.mjs",
        fn: "function actorToMonster",
        table: "monsters",
      },
    ];

    let written = [];
    for (const { file, fn, table } of IMPORTERS) {
      const src = file === "import-foundry.mjs" ? foundrySrc : read("scripts", file);
      // Sliced to the builder first: blockAfter takes the next `{` after
      // its match, so anchoring on the whole file would find whichever
      // row literal came first.
      const sliced = src.slice(src.indexOf(fn));
      const fields = topLevelKeys(
        blockAfter(sliced, /const (?:doc|row)\s*=/, `the row literal in ${fn}`),
        `${fn} row`
      );

      const tableFields =
        table === "npcs"
          ? schemaFields
          : topLevelKeys(
              blockAfter(
                schemaSrc,
                new RegExp(`\\b${table}:\\s*defineTable\\(`),
                `${table} table`
              ),
              `${table} schema`
            );

      for (const f of fields) {
        if (f === "campaignId") continue; // supplied by the caller
        if (!tableFields.includes(f)) {
          problems.push(
            `${fn} in ${file} writes \`${f}\`, which the ${table} schema does not accept — the import would fail validation`
          );
        }
      }
      // Required fields are checked against the bulk CSV importer only;
      // it is the one that has to produce a complete NPC row.
      if (fn === "const doc") written = fields;
    }

    // The Lookup tables are the only content in the app that is NOT
    // scoped to a campaign, and that is deliberate — a fireball is a
    // fireball in both groups. A campaignId appearing on one would make
    // it per-campaign again without anything else noticing.
    // The declaration AND its trailing .index()/.searchIndex() chain.
    // blockAfter stops at the object literal's closing brace, so the
    // indexes — which are what these checks are about — sit outside it.
    const tableRegion = (table) => {
      const start = schemaSrc.search(
        new RegExp(`\\b${table}:\\s*defineTable\\(`)
      );
      if (start === -1) throw new Error(`no ${table} table in schema.ts`);
      const next = schemaSrc.slice(start + 1).search(/\n  \w+: defineTable\(/);
      return next === -1
        ? schemaSrc.slice(start)
        : schemaSrc.slice(start, start + 1 + next);
    };

    for (const table of LOOKUP_TABLES) {
      const block = tableRegion(table);
      if (/campaignId/.test(block)) {
        problems.push(
          `the ${table} table has a campaignId — the reference library is ` +
            "shared across campaigns on purpose"
        );
      }
      if (!/searchIndex\(/.test(block)) {
        problems.push(
          `the ${table} table has no search index — Lookup would have to ` +
            "scan, and these are the only tables big enough for that to matter"
        );
      }
    }

    // Nothing writes the library from inside the app; it is loaded by
    // `npx convex import`. A mutation appearing here is a write path
    // that was never designed to be secured.
    const lookupSrc = read("convex", "lookup.ts");
    if (/\bmutation\(/.test(stripComments(lookupSrc))) {
      problems.push(
        "convex/lookup.ts defines a mutation — the reference library is " +
          "read-only in the app and loaded by `npx convex import`"
      );
    }

    // Changing the shape of a Lookup table means emptying it first —
    // Convex validates the rows already stored against the new schema
    // and rejects the push over a single leftover. clear-lookup.mjs is
    // what does the emptying, from a hand-written list, so a fourth
    // Lookup table would otherwise be added to the schema and quietly
    // left out of the one script that can unblock it.
    const cleared = constArrayStrings(
      read("scripts", "clear-lookup.mjs"),
      "TABLES",
      "clear-lookup.mjs"
    );
    for (const table of LOOKUP_TABLES) {
      if (!cleared.includes(table)) {
        problems.push(
          `clear-lookup.mjs does not empty ${table} — a change to its ` +
            "shape would be unpushable with no way to clear it"
        );
      }
    }
    for (const table of cleared) {
      // The inverse matters more: this script DELETES, and a name that
      // is no longer a Lookup table is a name that belongs to something
      // Derek typed by hand.
      if (!LOOKUP_TABLES.includes(table)) {
        problems.push(
          `clear-lookup.mjs empties \`${table}\`, which is not one of the ` +
            "Lookup tables — it deletes data, so it must only ever name " +
            "tables that can be re-imported"
        );
      }
    }

    // ---- every settings tab must have a panel, and vice versa -------
    // The strip and the panels read one declaration, but they read it in
    // two different ways: the strip maps over SETTINGS_TABS, the panels
    // are `tab === "id"` branches. Both failures are silent — a tab that
    // renders an empty page, or a section nothing can navigate to.
    const tabsSrc = read("components", "settingsTabs.ts");
    const declaredTabs = [
      ...tabsSrc
        .slice(tabsSrc.indexOf("SETTINGS_TABS"), tabsSrc.indexOf("];"))
        .matchAll(/id:\s*"([^"]+)"/g),
    ].map((m) => m[1]);

    if (declaredTabs.length === 0) {
      throw new Error("no tabs declared in settingsTabs.ts");
    }

    const panelSrc = read("components", "SettingsPanel.tsx");
    const rendered = [
      ...panelSrc.matchAll(/tab === "([^"]+)"/g),
    ].map((m) => m[1]);

    for (const id of declaredTabs) {
      if (!rendered.includes(id)) {
        problems.push(
          `settings tab "${id}" is declared but SettingsPanel renders no ` +
            "panel for it — it would be a tab you can click that shows " +
            "nothing"
        );
      }
    }
    for (const id of rendered) {
      if (!declaredTabs.includes(id)) {
        problems.push(
          `SettingsPanel renders a panel for "${id}", which is not a ` +
            "declared tab — nothing can select it, so those settings are " +
            "unreachable"
        );
      }
    }

    // ---- handing over the DM role -----------------------------------
    // The one mutation that changes WHO the DM is. Authority here is
    // structural — every other check in the app reads campaign.dmId — so
    // this single patch reassigns all of it at once, and the two things
    // guarding it are worth holding in place.
    // Read locally: campaignsSrc is declared further down, and reaching
    // it from here is a temporal-dead-zone error rather than a value.
    const transferSrc = read("convex", "campaigns.ts");
    const transferFn = transferSrc.slice(
      transferSrc.indexOf("export const transferDm")
    );
    if (!transferFn.startsWith("export const transferDm")) {
      throw new Error("no transferDm in convex/campaigns.ts");
    }
    const transferBody = transferFn.slice(0, transferFn.indexOf("\n});"));

    if (!/requireDm\(/.test(transferBody)) {
      problems.push(
        "campaigns.transferDm does not go through requireDm — anyone could " +
          "make themselves the DM of any campaign they can see"
      );
    }
    // The membership lookup has to be for the RECIPIENT. The outgoing
    // DM is looked up through the same index a few lines later, so
    // merely finding the index name here passed with the recipient's
    // check deleted — which is the whole check.
    const compactTransfer = transferBody.replace(/\s+/g, "");
    if (!/by_campaign_user[\s\S]{0,120}?args\.toUserId/.test(compactTransfer)) {
      problems.push(
        "campaigns.transferDm does not look up the RECIPIENT's membership — " +
          "a campaign handed to someone outside it is lost, since only its " +
          "DM can hand it back"
      );
    }

    // ---- date formats are a literal union in three places -----------
    // Same shape of problem as the rules edition: the schema validates
    // them, settings.ts re-declares them for the mutation, and
    // DATE_FORMATS renders them as buttons. An option offered but not
    // storable fails only when somebody clicks it.
    const schemaFormats = literalUnionAfter(
      schemaSrc,
      /dateFormat:\s*v\./,
      "schema.ts dateFormat"
    ).sort();
    const settingsFormats = literalUnionAfter(
      read("convex", "settings.ts"),
      /dateFormatValidator\s*=\s*v\./,
      "settings.ts dateFormatValidator"
    ).sort();
    const cardSrc = read("components", "campaignCard.ts");
    const formatsAt = cardSrc.indexOf("DATE_FORMATS");
    if (formatsAt === -1) throw new Error("no DATE_FORMATS in campaignCard.ts");
    const offeredFormats = [
      ...cardSrc
        .slice(formatsAt, cardSrc.indexOf("];", formatsAt))
        .matchAll(/value:\s*"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();

    for (const [label, list] of [
      ["convex/settings.ts", settingsFormats],
      ["DATE_FORMATS", offeredFormats],
    ]) {
      if (list.join() !== schemaFormats.join()) {
        problems.push(
          `date formats disagree: schema has [${schemaFormats}], ` +
            `${label} has [${list}]`
        );
      }
    }

    // ---- deleting a campaign must reach everything in it ------------
    // The one failure here is invisible by construction: a table left
    // out of the purge keeps its rows forever, and nothing ever reads
    // them, so there is no screen where the leak shows up. The schema is
    // the authority on what a campaign owns, so the list is derived from
    // it rather than written down twice.
    const campaignsSrc = read("convex", "campaigns.ts");
    const purge = campaignsSrc.slice(
      campaignsSrc.indexOf("export const purgeCampaign")
    );
    if (!purge.startsWith("export const purgeCampaign")) {
      throw new Error("no purgeCampaign in convex/campaigns.ts");
    }

    const ownedTables = [
      ...schemaSrc.matchAll(/\n  (\w+): defineTable\(\{([\s\S]*?)\n  \}\)/g),
    ]
      .filter(([, , body]) => /campaignId: v\.id\("campaigns"\)/.test(body))
      .map(([, table]) => table);

    if (ownedTables.length === 0) {
      throw new Error("found no campaign-scoped tables in schema.ts");
    }
    for (const table of ownedTables) {
      if (!new RegExp(`query\\("${table}"\\)`).test(purge)) {
        problems.push(
          `purgeCampaign never queries \`${table}\`, which carries a ` +
            "campaignId — deleting a campaign would strand its rows with " +
            "nothing left that can find them"
        );
      }
    }

    // The tables a campaign owns only through a parent. Named here
    // because the schema cannot say it: they carry an encounterId, a
    // pageId or a sessionId, so the rule above cannot see them.
    for (const [table, via] of [
      ["combatants", "encounters"],
      ["notebookBoxes", "notebookNodes"],
      ["sessionBoxes", "sessions"],
      ["sessionPages", "sessions"],
    ]) {
      if (!new RegExp(`query\\("${table}"\\)`).test(purge)) {
        problems.push(
          `purgeCampaign never queries \`${table}\` — it belongs to a ` +
            `campaign through ${via}, so nothing else will ever delete it`
        );
      }
    }

    // Deleting has to be harder than clicking. The typed name is the
    // entire safeguard, and it lives in the mutation rather than the
    // dialog so a direct call cannot skip it.
    const deleteFn = campaignsSrc.slice(
      campaignsSrc.indexOf("export const deleteCampaign"),
      campaignsSrc.indexOf("export const purgeCampaign")
    );
    // Both names have to be COMPARED, not merely mentioned. The
    // campaign's name appears in the error message either way, so a
    // check that only looked for the two strings would keep passing
    // after the comparison itself was gutted.
    const compactDelete = deleteFn.replace(/\s+/g, "");
    const comparesNames =
      /confirmName[^;{]{0,40}!==[^;{]{0,40}campaign\.name/.test(compactDelete) ||
      /campaign\.name[^;{]{0,40}!==[^;{]{0,40}confirmName/.test(compactDelete);
    if (!comparesNames) {
      problems.push(
        "campaigns.deleteCampaign does not compare the typed name against " +
          "the campaign's own — the confirmation would be advisory, and a " +
          "misfired call would delete a campaign outright"
      );
    }
    if (!/requireDm\(/.test(deleteFn)) {
      problems.push("campaigns.deleteCampaign does not go through requireDm");
    }

    // ---- the rules edition is a literal union in three places -------
    // The schema validates it, the mutation re-declares it, and
    // lookupFilters offers it as buttons. Add a third edition to one and
    // the others accept a value they cannot store, or offer one nobody
    // can pick — neither of which TypeScript sees, because the schema
    // and the component never meet.
    const editionLiterals = (src, label) =>
      literalUnionAfter(src, /rulesVersion:\s*v\./, label).sort();

    const schemaEditions = editionLiterals(schemaSrc, "schema.ts rulesVersion");
    const mutationEditions = editionLiterals(
      read("convex", "campaigns.ts"),
      "campaigns.ts rulesVersion"
    );
    // Bounded to the array's own literal. Every filter's options use
    // `value: "..."` too, so reading to the end of the file collects the
    // whole vocabulary of the screen instead of the two editions.
    const filtersFile = read("components", "lookupFilters.ts");
    const listAt = filtersFile.indexOf("RULES_VERSIONS");
    if (listAt === -1) throw new Error("no RULES_VERSIONS in lookupFilters.ts");
    const listEnd = filtersFile.indexOf("];", listAt);
    if (listEnd === -1) throw new Error("RULES_VERSIONS is not a closed array");
    const offered = [
      ...filtersFile.slice(listAt, listEnd).matchAll(/value:\s*"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();

    if (offered.length === 0) {
      throw new Error("RULES_VERSIONS offers no editions");
    }
    for (const [label, list] of [
      ["convex/campaigns.ts", mutationEditions],
      ["RULES_VERSIONS", offered],
    ]) {
      if (list.join() !== schemaEditions.join()) {
        problems.push(
          `rules editions disagree: schema has [${schemaEditions}], ` +
            `${label} has [${list}]`
        );
      }
    }

    // Setting it is a change to the whole table's game, so it belongs to
    // the DM by the same structural rule as every other game-state
    // mutation — not to whoever has the Settings page open.
    if (!/setRulesVersion[\s\S]{0,400}?requireDm\(/.test(read("convex", "campaigns.ts"))) {
      problems.push(
        "campaigns.setRulesVersion does not go through requireDm — the " +
          "edition is campaign-wide, so a player could change what the " +
          "whole table sees"
      );
    }

    // ---- the header and the rows must share one grid template -------
    // They are two separate grids that line up only because both are
    // handed the same value. Nothing in CSS or TypeScript connects them:
    // give the header the resized template and the rows the declared
    // one and every column sits under the wrong heading, with no error
    // anywhere and a table that simply reads wrong.
    const lookupToolSrc = read("components", "LookupTool.tsx");
    const cols = [
      ...lookupToolSrc.matchAll(
        /\["--lk-cols" as string\]:\s*([A-Za-z_$][\w$]*)/g
      ),
    ].map((m) => m[1]);
    if (cols.length < 2) {
      throw new Error(
        `expected --lk-cols to be set for both the header and the rows, ` +
          `found ${cols.length} in LookupTool.tsx`
      );
    }
    if (new Set(cols).size !== 1) {
      problems.push(
        `LookupTool sets --lk-cols from [${[...new Set(cols)].join(", ")}] — ` +
          "the header and the rows are separate grids and must be given " +
          "the same template or the columns drift out from under their " +
          "headings"
      );
    }

    // ---- the artwork mirror must be a path the map server serves ----
    // This is the failure it exists for: the importer stored Foundry's
    // own "icons/..." paths, the fetcher wrote files in Foundry's own
    // shape, and the Caddyfile routes /web/* and /originals/* and
    // nothing else. Each file was reasonable alone. Together they gave
    // 7,361 images a URL that answers 200 with the words "Map server
    // up." — which an <img> cannot decode, so onError hid every one and
    // nothing anywhere reported a problem.
    const mirrorSrc = read("scripts", "mirror.mjs");
    const mirrorMatch = mirrorSrc.match(
      /export const FOUNDRY_MIRROR\s*=\s*"([^"]+)"/
    );
    if (!mirrorMatch) {
      throw new Error("no FOUNDRY_MIRROR in scripts/mirror.mjs");
    }
    const mirror = mirrorMatch[1];

    // The route is on the other side of a boundary nothing else crosses:
    // a Caddy config, in another directory, deployed to another machine.
    const caddyfile = readFileSync(
      appPath("..", "map-server", "Caddyfile"),
      "utf8"
    );
    const routes = [...caddyfile.matchAll(/handle_path\s+\/([^/\s*]+)\/\*/g)].map(
      (m) => m[1]
    );
    if (routes.length === 0) {
      throw new Error("found no handle_path routes in map-server/Caddyfile");
    }
    const firstSegment = mirror.split("/")[0];
    if (!routes.includes(firstSegment)) {
      problems.push(
        `artwork is stored under "${mirror}/", but map-server/Caddyfile ` +
          `routes only [${routes.join(", ")}] — every image would answer ` +
          "with the landing page instead of a file"
      );
    } else {
      // Where to PUT the files is a third fact, in a third file, and it
      // only looks like the other two. `web` is a URL prefix Caddy
      // strips; /srv/web is a path inside the container; and the host
      // directory is whatever docker-compose mounts there. Copying to
      // the wrong one of those lands every file one directory away from
      // where it is served — which looks exactly like copying nothing.
      const rootMatch = caddyfile
        .slice(caddyfile.indexOf(`handle_path /${firstSegment}/*`))
        .match(/root\s+\*\s+(\S+)/);
      if (!rootMatch) {
        throw new Error(`no root for the /${firstSegment}/* route in Caddyfile`);
      }
      const compose = readFileSync(
        appPath("..", "map-server", "docker-compose.yml"),
        "utf8"
      );
      const mount = compose.match(
        new RegExp(`-\\s+(\\S+):${rootMatch[1]}(?::\\w+)?\\s*$`, "m")
      );
      if (!mount) {
        problems.push(
          `map-server/docker-compose.yml mounts nothing at ${rootMatch[1]}, ` +
            `which is what Caddy serves /${firstSegment}/* from`
        );
      } else if (
        // Comments stripped first: the header explains this mount, and
        // matching the explanation instead of the code would let the
        // printed command drift while the guard stayed green.
        !stripComments(read("scripts", "fetch-foundry-images.mjs")).includes(
          mount[1]
        )
      ) {
        problems.push(
          "fetch-foundry-images.mjs prints a copy command that does not " +
            `name ${mount[1]} — the directory docker-compose actually ` +
            `mounts as ${rootMatch[1]}`
        );
      }
    }

    // Both scripts must take the prefix from mirror.mjs. A second copy
    // spelled out by hand is how the two halves drift apart: files
    // written under one path, rows pointing at another.
    for (const file of ["import-foundry.mjs", "fetch-foundry-images.mjs"]) {
      const src = read("scripts", file);
      if (!/import \{ FOUNDRY_MIRROR \} from "\.\/mirror\.mjs"/.test(src)) {
        problems.push(
          `scripts/${file} does not import FOUNDRY_MIRROR from mirror.mjs`
        );
      }
      // The whole prefix, not a string that merely starts with it —
      // "foundry-import" is the importer's default output directory and
      // has nothing to do with the mirror.
      if (new RegExp(`"${mirror}(/|")`).test(stripComments(src))) {
        problems.push(
          `scripts/${file} spells out "${mirror}" instead of using ` +
            "FOUNDRY_MIRROR — the two copies can drift"
        );
      }
    }

    // ---- flags must not be read by position ------------------------
    // `args[args.indexOf("--from") + 1]` reads args[0] when the flag is
    // ABSENT, because indexOf returns -1 — and the `?? default` beside
    // it never fires, because args[0] is a string. That shipped, and
    // sent seven thousand requests to a URL built out of the export's
    // own filename. scripts/args.mjs is the replacement.
    for (const file of readdirSync(appPath("scripts"))) {
      if (!file.endsWith(".mjs") || file === "args.mjs") continue;
      const src = stripComments(read("scripts", file));
      if (/indexOf\([^)]*\)\s*\+\s*1\s*\]/.test(src)) {
        problems.push(
          `scripts/${file} reads a flag as \`indexOf(...) + 1\`, which ` +
            "resolves to the first positional argument when the flag is " +
            "absent — use parseArgs from scripts/args.mjs"
        );
      }
    }

    // Required (non-optional) schema fields must always be written, or
    // every row fails validation at import time.
    for (const field of schemaFields) {
      const decl = npcsBlockSrc.match(
        new RegExp(`^\\s*${field}:\\s*(.+)$`, "m")
      );
      if (!decl) continue;
      const optional = decl[1].includes("v.optional(");
      if (!optional && !written.includes(field)) {
        problems.push(
          `npcs.${field} is required but import-npcs.mjs never writes it`
        );
      }
    }

    // ---- themes must agree in four places --------------------------
    // The schema defines them, a bootstrap script in layout.tsx applies
    // one before first paint, globals.css defines the palettes, and
    // Settings offers the choice. Add a theme and forget the bootstrap
    // allowlist and it silently flashes the default on every load —
    // annoying, and invisible to anyone who never picked that theme.
    // Anchored on `theme:` itself, not on the table: userSettings holds
    // more than one literal union now, and reading the whole block
    // collected the date formats as if they were themes.
    const themes = literalUnionAfter(
      blockAfter(
        schemaSrc,
        /userSettings:\s*defineTable\(/,
        "userSettings in schema.ts"
      ),
      /theme:\s*v\./,
      "userSettings.theme"
    );

    const layout = read("app", "layout.tsx");
    const themeList = read("components", "themes.ts");
    const css = read("app", "globals.css");

    for (const theme of themes) {
      if (!layout.includes(`'${theme}'`)) {
        problems.push(
          `theme "${theme}" is missing from the bootstrap allowlist in ` +
            "layout.tsx — it would flash the default on every load"
        );
      }
      if (!themeList.includes(`"${theme}"`)) {
        problems.push(`theme "${theme}" is not offered in components/themes.ts`);
      }
    }

    // Two places offer the choice, and both must read the shared list —
    // a theme in one and not the other is a palette some people can
    // never reach.
    for (const file of ["SettingsPanel.tsx", "RibbonBar.tsx"]) {
      if (!/THEMES/.test(read("components", file))) {
        problems.push(
          `${file} offers a theme choice without reading the shared THEMES list`
        );
      }
    }

    // And nothing in the CSS may claim a theme the schema doesn't have.
    for (const [, named] of css.matchAll(/\[data-theme="([^"]+)"\]/g)) {
      if (!themes.includes(named)) {
        problems.push(
          `globals.css styles [data-theme="${named}"], which is not a theme ` +
            "the schema allows"
        );
      }
    }

    // ---- the calendar ----------------------------------------------
    // Three places describe the same settings: the schema, the mutation
    // that writes them, and the shared model that reconciles them. A
    // setting added to one and not the others is silently dropped on
    // save — the form edits it, the mutation never sends it.
    const calSrc = read("convex", "calendar.ts");

    if (!/from "\.\.\/components\/calendarModel"/.test(calSrc)) {
      problems.push(
        "convex/calendar.ts no longer imports the shared calendar model — " +
          "a second copy of the reconciliation rules is how a five-day " +
          "week ends up with seven day names"
      );
    }

    const calFields = topLevelKeys(
      blockAfter(schemaSrc, /calendars:\s*defineTable\(/, "calendars table"),
      "calendars schema"
    ).filter((f) => f !== "campaignId");

    // Sliced first: blockAfter takes the next `{` after its match, and
    // matching on the whole declaration would hand it mutation's own
    // object rather than the args literal inside it.
    const saveArgs = topLevelKeys(
      blockAfter(
        calSrc.slice(calSrc.indexOf("export const saveCalendar")),
        /args:/,
        "saveCalendar args"
      ),
      "saveCalendar args"
    ).filter((f) => f !== "campaignId");

    for (const f of calFields) {
      if (!saveArgs.includes(f)) {
        problems.push(
          `the calendars table stores \`${f}\` but saveCalendar never takes it — ` +
            "editing it would silently do nothing"
        );
      }
    }
    for (const f of saveArgs) {
      if (!calFields.includes(f)) {
        problems.push(
          `saveCalendar takes \`${f}\`, which the calendars table has no column for`
        );
      }
    }

    // ---- the repeat rules are stated in four places -----------------
    // The schema validates them, calendar.ts re-declares them for the
    // mutation, REPEATS offers them in the event form, and occursOn
    // decides what they mean. The fourth is the one that cannot be
    // caught by anything else: its switch ends in a `default` that
    // treats an unrecognised rule as happening once, which is the right
    // answer for a row written by a newer client and the wrong one for a
    // rule this build was supposed to know. A rule added everywhere but
    // the switch just quietly stops recurring — the form offers it, the
    // mutation stores it, and the calendar shows it a single time.
    const schemaRepeats = literalUnionAfter(
      schemaSrc,
      /repeat:\s*v\.union/,
      "schema.ts calendarEvents.repeat"
    ).sort();
    const validatorRepeats = literalUnionAfter(
      calSrc,
      /repeatValidator\s*=\s*v\./,
      "calendar.ts repeatValidator"
    ).sort();

    // Bounded to the array's own literal, for the same reason as
    // RULES_VERSIONS: `value: "..."` is the shape of every option list
    // in the file.
    const modelSrc = read("components", "calendarModel.ts");
    const repeatsAt = modelSrc.indexOf("REPEATS");
    if (repeatsAt === -1) throw new Error("no REPEATS in calendarModel.ts");
    const repeatsEnd = modelSrc.indexOf("];", repeatsAt);
    if (repeatsEnd === -1) throw new Error("REPEATS is not a closed array");
    const offeredRepeats = [
      ...modelSrc
        .slice(repeatsAt, repeatsEnd)
        .matchAll(/value:\s*"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
    if (offeredRepeats.length === 0) {
      throw new Error("REPEATS offers no rules");
    }

    const occursAt = modelSrc.indexOf("export function occursOn");
    if (occursAt === -1) throw new Error("no occursOn in calendarModel.ts");
    const handledRepeats = [
      ...modelSrc.slice(occursAt).matchAll(/case\s+"([^"]+)":/g),
    ]
      .map((m) => m[1])
      .sort();
    if (handledRepeats.length === 0) {
      throw new Error("occursOn handles no rules by name — parser out of date?");
    }

    for (const [label, list] of [
      ["convex/calendar.ts", validatorRepeats],
      ["REPEATS", offeredRepeats],
      ["occursOn", handledRepeats],
    ]) {
      if (list.join() !== schemaRepeats.join()) {
        problems.push(
          `event repeat rules disagree: schema has [${schemaRepeats}], ` +
            `${label} has [${list}]`
        );
      }
    }

    // The rule that reads an interval must be the rule saveEvent
    // normalises one for. Scoped to the HANDLER, not the file: the
    // validator a few lines above lists every rule by name, so reading
    // the whole of calendar.ts finds "everyNDays" whether or not
    // anything acts on it — a check that can only pass.
    const saveEventAt = calSrc.indexOf("export const saveEvent");
    if (saveEventAt === -1) {
      throw new Error("no saveEvent in convex/calendar.ts");
    }
    const saveEventBody = blockAfter(
      calSrc.slice(saveEventAt),
      /handler:/,
      "saveEvent handler"
    );
    for (const rule of offeredRepeats) {
      // Only the rules that carry a number need normalising, and
      // everyNDays is the only one that does. Named rather than derived:
      // a rule with its own field would need its own clamp anyway.
      if (rule !== "everyNDays") continue;
      if (!saveEventBody.includes(rule)) {
        problems.push(
          `saveEvent never branches on "${rule}", so the interval it stores ` +
            "is whatever the form sent — a 0 divides by nothing and the " +
            "event silently never recurs"
        );
      }
      if (!/Math\.max\(\s*1\s*,/.test(saveEventBody)) {
        problems.push(
          "saveEvent does not floor the repeat interval at 1 — a 0 or a " +
            "negative interval is a modulo by nothing"
        );
      }
    }

    // ---- no control characters in source ---------------------------
    // A NUL byte reached a committed file this way: `join(" ")` was
    // written with a NUL where the space belonged. Nothing caught it.
    // It compiled, it typechecked, the build succeeded, and the unit
    // tests passed — a NUL is a perfectly good separator — so the only
    // symptom was `grep` reporting the file as binary and refusing to
    // search it.
    //
    // That is the whole shape of a silent failure: no error, correct
    // behaviour, and a file the tools quietly stop being able to read.
    // Tab, newline and carriage return are the only control characters
    // source has any business containing.
    //
    // DEL (0x7f) counts. It sits ABOVE the printable range rather than
    // below it, so a "code > 31" test waves it through — which it did:
    // a DEL reached components/uiRegistry.ts and was found by hand,
    // days after this guard was written to catch exactly that.
    for (const [file, src] of sourceFiles("components", "convex", "app")) {
      for (let i = 0; i < src.length; i++) {
        const code = src.charCodeAt(i);
        const control =
          (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 127;
        if (!control) continue;
        const line = src.slice(0, i).split("\n").length;
        problems.push(
          `${file}:${line} contains a control character (0x${code
            .toString(16)
            .padStart(2, "0")}) — it will compile and make the file binary ` +
            "to grep and to diffs"
        );
        break;
      }
    }

    // ---- edit mode: the registry and the screens agree --------------
    // Both directions, because both fail silently and differently.
    //
    // A registered id nothing renders is a row in the editor that does
    // nothing when you rename it — you type a new heading, save, and
    // the screen keeps the old one, with no error anywhere.
    //
    // An id rendered but not registered is worse: useUiText falls back
    // to the id itself, so the button reads "npc.bar.sort".
    {
      const registry = read("components", "uiRegistry.ts");
      const declared = [
        ...registry.matchAll(/\{\s*id:\s*"([^"]+)"/g),
      ].map((m) => m[1]);
      if (declared.length === 0) {
        throw new Error("no ids found in uiRegistry.ts — parser out of date?");
      }

      // Every id mentioned anywhere else in the app, however it is
      // written: <UiText id="x" />, useUiText("x"), useUiLayout("x"),
      // and the ternary form <UiText id={cond ? "a" : "b"} />.
      const used = new Set();
      /** Families rendered from a loop, as the literal part of the id. */
      const prefixes = [];
      for (const [file, src] of sourceFiles("components", "app")) {
        if (file.endsWith("uiRegistry.ts")) continue;
        const code = stripComments(src);
        for (const m of code.matchAll(
          /(?:UiText\s+id=|useUiText\(|useUiLayout\(|UiSplitHandle\s+id=|labelId=|titleId=|blurbId=)\s*\{?\s*"([^"]+)"/g
        )) {
          used.add(m[1]);
        }
        // The ternary picks between two ids; the regex above catches the
        // first, this catches the second.
        for (const m of code.matchAll(/\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
          if (declared.includes(m[1])) used.add(m[1]);
          if (declared.includes(m[2])) used.add(m[2]);
        }

        // A whole family rendered from a loop: <UiText id={`a.b.${x}`} />.
        // The prefix is all that can be read statically, so it marks the
        // family as rendered — and the UNIT guard then checks the exact
        // correspondence against the list being looped over, which is
        // the part a regex could never do.
        for (const m of code.matchAll(
          /(?:UiText\s+id=|useUiText\(|useUiLayout\()\s*\{?\s*`([^`$]+)\$\{/g
        )) {
          prefixes.push(m[1]);
        }
      }

      // A prefix is only allowed to excuse a family, never the whole
      // registry. `id.startsWith("")` is true of every id, so a short or
      // empty prefix would switch the orphan check off without failing
      // anything — the guard would go on reporting green while checking
      // nothing, which is the failure this whole suite exists to stop.
      for (const prefix of prefixes) {
        if (prefix.length < 4 || !prefix.includes(".")) {
          problems.push(
            `edit mode renders a family of ids from the prefix ` +
              `"${prefix}", which is too broad to tell one family from ` +
              "another — every registered id would count as rendered"
          );
        }
      }

      for (const id of declared) {
        if (!used.has(id) && !prefixes.some((p) => id.startsWith(p))) {
          problems.push(
            `uiRegistry declares "${id}" but nothing renders it — edit ` +
              "mode would offer a rename that changes nothing on screen"
          );
        }
      }
      for (const id of used) {
        if (!declared.includes(id)) {
          problems.push(
            `"${id}" is rendered through edit mode but is not in ` +
              "uiRegistry — it would show up on screen as its own id"
          );
        }
      }
    }

    // ---- edit mode never nests interactive content ------------------
    // <button> inside <button> makes the HTML PARSER close the outer
    // one, so React hydrates a different tree than it rendered and the
    // page comes back wrong. UiText goes inside tabs, toolbar buttons
    // and checkbox labels, so it must never render a button or an input
    // of its own — the rename field opens in a portal at the end of
    // <body> instead, where it is inside nothing.
    {
      const src = stripComments(read("components", "UiEditor.tsx"));
      const uiText = src.slice(
        src.indexOf("export function UiText"),
        src.indexOf("function RenamePopover")
      );
      if (uiText.length < 100) {
        throw new Error("could not find UiText in UiEditor.tsx");
      }
      for (const tag of ["<button", "<input", "<select", "<textarea", "<a "]) {
        if (uiText.includes(tag)) {
          problems.push(
            `UiText renders ${tag}> — it is rendered inside buttons and ` +
              "labels, and interactive content nested there makes the " +
              "parser restructure the tree and React fail to hydrate"
          );
        }
      }
      // The CALL, inside RenamePopover — not the import, which an
      // unused import satisfies while the field renders inline.
      const popover = src.slice(src.indexOf("function RenamePopover"));
      if (!/return createPortal\(/.test(popover)) {
        problems.push(
          "the rename field is no longer portalled to <body> — inside a " +
            "<button> it is invalid content and will not take a click"
        );
      }
    }

    // ---- a hidden field is actually off the record ------------------
    // The model can mark it hidden all it likes; if the record does not
    // read the flag, hiding is a switch that does nothing. Unit tests
    // cover the model and cannot see the rendering, so this is the half
    // that needs saying here.
    {
      const src = stripComments(read("components", "NpcDetail.tsx"));
      if (!/if \(!arranging && f\.hidden\) return null;/.test(src)) {
        problems.push(
          "NpcDetail does not skip hidden fields — the hide switch would " +
            "mark them in the layout and change nothing on the record"
        );
      }
      // And the other half: while arranging they must NOT be skipped,
      // or a hidden field is one nobody can ever un-hide.
      if (!/arranging \? " tpl-field" : ""|tpl-hidden/.test(src)) {
        problems.push(
          "NpcDetail no longer marks hidden fields while arranging — a " +
            "hidden field you cannot see is one you cannot bring back"
        );
      }
    }

    // ---- the template writer and its table agree --------------------
    // saveTemplate wrote `rows` for weeks while the npcTemplates
    // validator declared only { key, span }. Convex objects are STRICT,
    // so every save of a layout failed validation at write time — the
    // designer's Save button had never worked, and nothing said so
    // because the failure is a thrown mutation nobody was watching.
    {
      const npcsSrc = read("convex", "npcs.ts");
      const schemaSrc = read("convex", "schema.ts");

      const written = [
        ...blockAfter(npcsSrc, /fields: t\.fields\.map\(\(f\) => \(/, "the saveTemplate field writer")
          .matchAll(/^\s*(?:\.\.\.\(f\.)?([a-zA-Z]\w*)\s*[:?]/gm),
      ].map((m) => m[1]);
      if (written.length === 0) {
        throw new Error("could not read saveTemplate's field writer");
      }

      // Sliced from the table first, THEN the field object. blockAfter
      // anchors on where its pattern STARTS, so a pattern spanning from
      // the table name to the field object hands back the table's own
      // braces — which read as a field list of { campaignId, tabs } and
      // reported every real field as undeclared.
      const templateTable = schemaSrc.slice(
        schemaSrc.indexOf("npcTemplates: defineTable")
      );
      if (!templateTable) {
        throw new Error("no npcTemplates table in schema.ts");
      }
      const declared = topLevelKeys(
        blockAfter(
          templateTable,
          /fields: v\.array\(\s*v\.object\(/,
          "the npcTemplates field validator"
        ),
        "the npcTemplates field validator"
      );

      for (const key of written) {
        if (!declared.includes(key)) {
          problems.push(
            `saveTemplate writes \`${key}\` but the npcTemplates validator ` +
              "does not declare it — Convex objects are strict, so every " +
              "save of a layout would fail validation"
          );
        }
      }
    }

    // ---- the sidebar is declared in three places, and they agree ----
    // Exactly the failure above, one screen over. A key added to
    // SidebarSection and not to both validators does not degrade: the
    // designer works, the sidebar renders, and every Save of the whole
    // layout fails validation — which is how `rows` shipped on the
    // record template and how nobody noticed for a day.
    //
    // Three copies because there are three compilations: the component
    // interface, the mutation's argument validator, and the table.
    // TypeScript checks none of them against the others.
    {
      const layoutSrc = stripComments(read("components", "sidebarLayout.ts"));
      const settingsSrc = read("convex", "settings.ts");
      const schemaSrc = read("convex", "schema.ts");

      // `id: string;` and `dmOnly?: boolean;` both declare a field, and
      // topLevelKeys does not read the optional marker — so this reads
      // the interface itself rather than borrowing that helper.
      const ifaceBody = blockAfter(
        layoutSrc,
        /export interface SidebarSection\s*/,
        "the SidebarSection interface"
      );
      const ifaceKeys = [
        ...ifaceBody.matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm),
      ].map((m) => m[1]);
      if (ifaceKeys.length === 0) {
        throw new Error("read no keys off SidebarSection — parser out of date?");
      }

      const validatorKeys = (src, anchor, label) =>
        [
          ...blockAfter(src, anchor, label).matchAll(
            /^\s*([A-Za-z_$][\w$]*)\s*:/gm
          ),
        ].map((m) => m[1]);

      // The mutation's validator: the section object inside
      // sidebarValidator's `sections: v.array(v.object({ … }))`.
      const mutationKeys = validatorKeys(
        settingsSrc.slice(settingsSrc.indexOf("export const sidebarValidator")),
        /sections: v\.array\(\s*v\.object\(/,
        "the sidebarValidator section object"
      );

      // And the table's, sliced from userSettings first so the anchor
      // cannot run away into another table's `sections:`.
      const settingsTable = schemaSrc.slice(
        schemaSrc.indexOf("userSettings: defineTable")
      );
      if (!settingsTable) {
        throw new Error("no userSettings table in schema.ts");
      }
      const tableKeys = validatorKeys(
        settingsTable,
        /sections: v\.array\(\s*v\.object\(/,
        "the schema's sidebar section validator"
      );

      for (const key of ifaceKeys) {
        for (const [where, keys] of [
          ["settings.sidebarValidator", mutationKeys],
          ["the userSettings table", tableKeys],
        ]) {
          if (!keys.includes(key)) {
            problems.push(
              `SidebarSection declares \`${key}\` but ${where} does not — ` +
                "Convex objects are strict, so saving a sidebar would fail " +
                "validation outright rather than dropping the field"
            );
          }
        }
      }
      // The other direction, which is a quieter loss: a validator key
      // nothing writes is a setting that can be stored and can never
      // be read back into anything.
      for (const key of mutationKeys) {
        if (!ifaceKeys.includes(key)) {
          problems.push(
            `settings.sidebarValidator accepts \`${key}\`, which is not a ` +
              "field of SidebarSection — nothing writes it and nothing " +
              "reads it"
          );
        }
      }
    }

    // ---- invites: the two copies of the rules agree -----------------
    // The limits are stated twice — inviteModel.ts for the screen,
    // constants in convex/campaigns.ts for the mutation — because
    // convex/ and components/ are separate compilations. Two copies
    // that disagree means the UI offers 90 days and the server issues
    // 14, silently.
    {
      const modelSrc = read("components", "inviteModel.ts");
      const serverSrc = read("convex", "campaigns.ts");

      const modelLimits = blockAfter(
        modelSrc,
        /export const INVITE_LIMITS =/,
        "INVITE_LIMITS"
      );
      const numberIn = (src, name) => {
        const m = src.match(new RegExp(`${name}:?\\s*=?\\s*(\\d+)`));
        if (!m) throw new Error(`no ${name} in the invite limits`);
        return Number(m[1]);
      };

      const pairs = [
        ["defaultDays", "INVITE_DEFAULT_DAYS"],
        ["maxDays", "INVITE_MAX_DAYS"],
        ["defaultUses", "INVITE_DEFAULT_USES"],
        ["maxUses", "INVITE_MAX_USES"],
      ];
      for (const [modelName, serverName] of pairs) {
        const a = numberIn(modelLimits, modelName);
        const b = numberIn(serverSrc, serverName);
        if (a !== b) {
          problems.push(
            `invite limit ${modelName} is ${a} on the screen and ` +
              `${serverName} is ${b} on the server — the DM would be ` +
              "offered one thing and issued another"
          );
        }
      }

      // The gate is acceptInvite, not peekInvite. peek exists so a
      // stranger can see what they were invited to; if it were the only
      // check, the minutes spent creating an account would be minutes
      // in which a revoked link still worked.
      const accept = serverSrc.slice(serverSrc.indexOf("export const acceptInvite"));
      for (const [needle, what] of [
        ["requireUser", "require a signed-in caller"],
        ["revokedAt !== undefined", "refuse a revoked link"],
        ["expiresAt <= Date.now()", "refuse an expired link"],
        ["usesLeft <= 0", "refuse a spent link"],
      ]) {
        if (!accept.includes(needle)) {
          problems.push(
            `acceptInvite does not ${what} — peekInvite checking it is ` +
              "not enough, they are minutes apart in a flow that includes " +
              "creating an account"
          );
        }
      }

      // peekInvite answers to nobody by design, so what it returns is
      // the whole of what a stranger can learn.
      const peek = serverSrc.slice(
        serverSrc.indexOf("export const peekInvite"),
        serverSrc.indexOf("export const acceptInvite")
      );
      if (peek.includes("requireUser") || peek.includes("requireMember")) {
        problems.push(
          "peekInvite now requires an account — the person clicking an " +
            "invite does not have one yet, which is the entire point of it"
        );
      }
      // What it RETURNS, not what it reads. It has to read
      // invite.campaignId to find the campaign at all; the question is
      // only what leaves the server.
      const allowed = [
        "ok",
        "problem",
        "campaignName",
        "dmName",
        "characterName",
      ];
      const returned = new Set();
      for (const m of peek.matchAll(/return \{/g)) {
        const body = blockAfter(
          peek.slice(m.index),
          /return /,
          "a peekInvite return"
        );
        for (const key of body.matchAll(/^\s*([a-zA-Z_$][\w$]*)\s*:/gm)) {
          returned.add(key[1]);
        }
      }
      if (returned.size === 0) {
        throw new Error("could not read what peekInvite returns");
      }
      for (const key of returned) {
        if (!allowed.includes(key)) {
          problems.push(
            `peekInvite returns \`${key}\` — it answers to nobody, so it ` +
              "must hand a stranger the campaign's name, the DM's and the " +
              "character's, and nothing else"
          );
        }
      }
    }

    // ---- a player who may write cannot write the DM's fields --------
    // Players can create NPCs and keep editing the ones they made, so
    // updateNpc is no longer DM-only — which makes the DM-only field
    // list load-bearing. A fourth DM-only column added to the schema
    // and not to that list is a field a player could write.
    {
      const npcsSrc = stripComments(read("convex", "npcs.ts"));
      const listed = constArrayStrings(
        npcsSrc,
        "DM_ONLY_FIELDS",
        "convex/npcs.ts"
      );
      // DERIVED, not a literal list.
      //
      // This used to check a hard-coded ["hidden", "dmNotes", "secret"],
      // which had both failure modes at once: it could not see a FOURTH
      // DM-only field added to updateNpc and forgotten here — the exact
      // thing it exists to catch — and it failed on a field legitimately
      // retired, which is how it got read as noise. The invariant is a
      // relation between three lists, so all three are read.
      const columnsSrc = stripComments(read("components", "npcColumns.ts"));
      const dmColumns = [
        ...columnsSrc.matchAll(/key:\s*"(\w+)"[^}]*dmOnly:\s*true/g),
      ].map((m) => m[1]);
      if (dmColumns.length === 0) {
        throw new Error("read no dmOnly columns out of npcColumns.ts");
      }

      const updateAt = npcsSrc.indexOf("export const updateNpc");
      if (updateAt === -1) throw new Error("no updateNpc in convex/npcs.ts");
      const updateArgs = topLevelKeys(
        blockAfter(npcsSrc.slice(updateAt), /args:/, "updateNpc args"),
        "updateNpc args"
      );

      // Every DM-only column updateNpc actually accepts must be on the
      // refusal list, or a player editing an NPC they created writes it.
      for (const key of dmColumns) {
        if (updateArgs.includes(key) && !listed.includes(key)) {
          problems.push(
            `updateNpc accepts \`${key}\`, a dmOnly column, but ` +
              "DM_ONLY_FIELDS does not list it — a player editing an NPC " +
              "they created could write it"
          );
        }
      }
      // And nothing on the refusal list may be a field updateNpc does
      // not take. That entry refuses nothing, and reads like cover.
      for (const key of listed) {
        if (!updateArgs.includes(key)) {
          problems.push(
            `DM_ONLY_FIELDS names \`${key}\`, which updateNpc does not ` +
              "accept — it guards nothing and makes the list look longer " +
              "than the protection it provides"
          );
        }
      }
      if (!/if \(!isDm && !isCreator\)/.test(npcsSrc)) {
        problems.push(
          "updateNpc no longer refuses a caller who is neither the DM nor " +
            "the NPC's creator"
        );
      }
    }

    // ---- no state updater used for its side effect ------------------
    // `setPos((p) => { onChange(...); return p; })` reads as "give me
    // the current value", and it does — but React runs an updater
    // during the RENDER phase, so whatever it calls updates state while
    // another component is rendering. React says so at runtime and
    // nothing says so before then.
    //
    // The tell is precise: an updater that hands its argument straight
    // back is not updating anything, so it is only there for what it
    // does on the way. Read the value from a ref or a closure and call
    // the side effect from the event handler instead.
    for (const [file, src] of sourceFiles("components", "app")) {
      if (!file.endsWith(".tsx")) continue;
      for (const hit of sideEffectUpdaters(file, src)) {
        problems.push(
          `${file}:${hit.line} calls ${hit.setter} with an updater that ` +
            "returns its argument unchanged — React runs updaters during " +
            "render, so its side effect is a state update mid-render"
        );
      }
    }

    // ---- no hook an early return can skip ---------------------------
    // React counts hooks by POSITION. A hook below a conditional return
    // runs on some renders and not others, and the component throws
    // "rendered more hooks than during the previous render" — taking
    // the whole screen with it.
    //
    // Nothing else sees this. It typechecks, it builds, and it does not
    // fire on first paint: the early return here was `if (stored ===
    // undefined)`, so the count went 16, then 17 the moment the Convex
    // query resolved. The Settings page threw on load.
    for (const [file, src] of sourceFiles("components", "app")) {
      if (!file.endsWith(".tsx")) continue;
      for (const hit of conditionalHooks(file, src)) {
        problems.push(
          `${file}:${hit.line} calls a hook below an earlier return ` +
            `(${hit.text}) — React counts hooks by position, so this one ` +
            "runs on some renders and not others"
        );
      }
    }

    // ---- no component declared inside another component -------------
    // The symptom is unforgettable and the cause is invisible: you can
    // type one letter into a field, and then it loses focus and you
    // have to click it again. A function declared during render is a
    // NEW component type on every render, so React unmounts the old
    // tree and mounts a fresh one — new DOM node, no caret.
    //
    // Nothing else catches it. It compiles, it typechecks, it builds,
    // and it renders the right pixels. Top-level declarations start at
    // column zero, so an indented one is nested by definition.
    for (const [file, src] of sourceFiles("components", "app")) {
      if (!file.endsWith(".tsx")) continue;
      const lines = stripComments(src).split("\n");
      lines.forEach((line, i) => {
        const m = line.match(
          /^[ \t]+(?:function\s+([A-Z][\w$]*)\s*\(|const\s+([A-Z][\w$]*)\s*=\s*\()/
        );
        if (!m) return;
        problems.push(
          `${file}:${i + 1} declares ${m[1] ?? m[2]} inside another ` +
            "function — React remounts it every render, so a field in it " +
            "loses focus after one keystroke. Move it to module level."
        );
      });
    }

    // ---- no two modules whose names differ only in case -------------
    // This one is invisible on Linux and fatal on a Mac. Next to
    // lookupFilters.ts sat LookupFilters.tsx; on a case-SENSITIVE disk
    // each import resolved to the file it named and every guard was
    // green, including in CI. On Derek's case-INSENSITIVE disk
    // TypeScript resolved both specifiers to the same file — it tries
    // `.ts` before `.tsx` — and the build failed with TS1149 on a
    // branch that had already been called done.
    //
    // Extensions are stripped before comparing, because that is what an
    // import specifier is: `@/components/LookupFilters` names no
    // extension, so `.ts` and `.tsx` siblings collide even though their
    // filenames do not.
    const byLowerName = new Map();
    for (const [file] of sourceFiles("components", "convex", "app")) {
      const specifier = file.replace(/\.tsx?$/, "");
      const key = specifier.toLowerCase();
      const seen = byLowerName.get(key);
      if (seen && seen !== file) {
        problems.push(
          `${seen} and ${file} differ only in case — an import of ` +
            `"${specifier}" resolves to whichever one the filesystem ` +
            "hands over first, so this builds on Linux and fails on macOS"
        );
      } else {
        byLowerName.set(key, file);
      }
    }

    // ---- Lookup: the kind union is stated twice --------------------
    // lookupFilters.ts cannot import it: the unit guard compiles pure
    // modules in isolation and TypeScript's path mapping is
    // compile-time only, so an imported sibling would leave an
    // unresolvable specifier in the emitted JS. Two copies, checked.
    const kinds = (file) => {
      const src = read("components", file);
      const m = src.match(/type LookupKind =([^;]+);/);
      if (!m) throw new Error(`no LookupKind in ${file}`);
      return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    };
    const fieldKinds = kinds("lookupFields.ts");
    const filterKinds = kinds("lookupFilters.ts");
    if (fieldKinds.join() !== filterKinds.join()) {
      problems.push(
        `LookupKind disagrees: lookupFields has [${fieldKinds}], ` +
          `lookupFilters has [${filterKinds}]`
      );
    }
    // Every kind must have a filter set and a column set behind it, or
    // its screen renders a bar and a table with nothing in them.
    const filtersSrc = read("components", "lookupFilters.ts");
    const fieldsSrc = read("components", "lookupFields.ts");
    for (const kind of fieldKinds) {
      if (!new RegExp(`\\b${kind}:\\s*\\w*FILTERS`).test(filtersSrc)) {
        problems.push(`LookupKind "${kind}" has no entry in FILTERS`);
      }
      if (
        !new RegExp(`\\b${kind}:\\s*\\[`).test(
          fieldsSrc.slice(fieldsSrc.indexOf("LOOKUP_COLUMNS"))
        )
      ) {
        problems.push(`LookupKind "${kind}" has no entry in LOOKUP_COLUMNS`);
      }
    }

    // ---- every kind has a screen, a route, and two queries ---------
    // Four separate ways a Lookup kind is half-wired, all silent:
    // declared with no nav entry (a screen nothing links to), no route
    // folder (a sidebar link that 404s), or no index/get query (a table
    // that loads nothing, or rows that will not open).
    {
      const lookupSrc = read("convex", "lookup.ts");
      const navSrcLocal = read("components", "navItems.ts");
      // getSpell, getClass, getSpecies — singular and irregular, so
      // stated rather than derived from the plural.
      const GETTERS = {
        spells: "getSpell",
        items: "getItem",
        monsters: "getMonster",
        feats: "getFeat",
        backgrounds: "getBackground",
        classes: "getClass",
        species: "getSpecies",
      };

      for (const kind of fieldKinds) {
        const Index = `index${kind[0].toUpperCase()}${kind.slice(1)}`;
        if (!lookupSrc.includes(`export const ${Index} = query`)) {
          problems.push(
            `LookupKind "${kind}" has no ${Index} query — the screen would ` +
              "render an empty library with nothing saying why"
          );
        }
        const getter = GETTERS[kind];
        if (!getter) {
          problems.push(
            `LookupKind "${kind}" has no getter named in the guard's ` +
              "GETTERS map — add it, so the row-open query is checked too"
          );
        } else if (!lookupSrc.includes(`export const ${getter} = query`)) {
          problems.push(
            `LookupKind "${kind}" has no ${getter} query — its rows would ` +
              "list fine and open to nothing"
          );
        }
      }

      // Every kind must be a TAB, and the tab strip must have a route.
      //
      // This used to demand a nav item and a route PER KIND, which was
      // right while there were seven sidebar entries and is exactly
      // wrong now: they are tabs on one page. The invariant did not go
      // away, it moved — a kind missing from LOOKUP_TABS is a table
      // with no way to reach it, which is the same loss the per-route
      // version was guarding against.
      const tabs = [
        ...between(
          fieldsSrc,
          "export const LOOKUP_TABS",
          "];",
          "LOOKUP_TABS"
        ).matchAll(/"(\w+)"/g),
      ].map((m) => m[1]);
      if (tabs.length === 0) {
        throw new Error("read no tabs out of LOOKUP_TABS");
      }
      for (const kind of fieldKinds) {
        if (!tabs.includes(kind)) {
          problems.push(
            `LookupKind "${kind}" is not in LOOKUP_TABS — its table exists ` +
              "and there is no tab that reaches it"
          );
        }
      }
      for (const tab of tabs) {
        if (!fieldKinds.includes(tab)) {
          problems.push(
            `LOOKUP_TABS offers "${tab}", which is not a LookupKind — the ` +
              "tab would render a table with no columns behind it"
          );
        }
      }
      if (!exists("app", "campaign", "[campaignId]", "lookup", "page.tsx")) {
        problems.push(
          "there is no route at app/campaign/[campaignId]/lookup/page.tsx — " +
            "the sidebar's Lookup link would 404 and every tab with it"
        );
      }
      if (!/id: "lookup"/.test(navSrcLocal)) {
        problems.push(
          "navItems has no `lookup` entry — the whole reference library " +
            "would exist with nothing linking to it"
        );
      }

      // ---- and its columns and filters read fields it returns -------
      // The index query strips the heavy fields, and the columns and
      // filters address what is left BY STRING. A column reading a
      // field the query does not send renders an em dash on every row
      // forever; a filter reading one silently matches nothing. Both
      // type-check perfectly, because a Row is Record<string, unknown>.
      const returnedFields = (kind) => {
        const Index = `index${kind[0].toUpperCase()}${kind.slice(1)}`;
        const at = lookupSrc.indexOf(`export const ${Index} = query`);
        if (at === -1) return null;
        const body = blockAfter(
          lookupSrc.slice(at),
          /rows: rows\.map\(\(r\) => \(/,
          `${Index}'s row projection`
        );
        return new Set(
          [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
        );
      };

      /** Fields every row carries without the projection naming them. */
      const ALWAYS = new Set(["_id", "_creationTime"]);

      const readsOf = (source, receiver) =>
        new Set(
          [...source.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)`, "g"))].map(
            (m) => m[1]
          )
        );

      // The kind's slice of LOOKUP_COLUMNS: from `kind: [` to the line
      // that closes it at the record's own indent.
      const sliceOfRecord = (src, recordName, kind) => {
        const rec = src.indexOf(recordName);
        if (rec === -1) return null;
        const start = src.indexOf(`\n  ${kind}: [`, rec);
        if (start === -1) return null;
        const end = src.indexOf("\n  ],", start);
        return end === -1 ? null : src.slice(start, end);
      };

      for (const kind of fieldKinds) {
        const returned = returnedFields(kind);
        if (!returned) continue;

        const columnSlice = sliceOfRecord(fieldsSrc, "LOOKUP_COLUMNS", kind);
        if (!columnSlice) {
          // NAME_COLUMN and friends are shared constants spliced in, so
          // a kind can legitimately have no inline slice — but every
          // kind added since does, and silently skipping all of them
          // would make this whole check a no-op.
          problems.push(
            `could not read LOOKUP_COLUMNS.${kind} — the field check ` +
              "cannot run, which is worse than it failing"
          );
          continue;
        }
        for (const field of readsOf(columnSlice, "r")) {
          if (!returned.has(field) && !ALWAYS.has(field)) {
            problems.push(
              `LOOKUP_COLUMNS.${kind} reads \`${field}\`, which the index ` +
                "query does not return — that column is an em dash on " +
                "every row, forever"
            );
          }
        }

        // The filter set, reached through the FILTERS record's mapping
        // from kind to the const holding it.
        const m = new RegExp(`\\b${kind}:\\s*(\\w+),`).exec(
          filtersSrc.slice(filtersSrc.indexOf("export const FILTERS"))
        );
        if (!m) continue;
        const filterConst = m[1];
        const fstart = filtersSrc.indexOf(`const ${filterConst}: FilterDef[]`);
        if (fstart === -1) continue;
        const fslice = filtersSrc.slice(
          fstart,
          filtersSrc.indexOf("\n];", fstart)
        );
        for (const field of readsOf(fslice, "row")) {
          if (!returned.has(field) && !ALWAYS.has(field)) {
            problems.push(
              `${filterConst} matches on \`${field}\`, which ${kind}'s index ` +
                "query does not return — that filter silently matches nothing"
            );
          }
        }
      }
    }

    // A filter chip that matches nothing is invisible: it renders, it
    // is clickable, and it silently returns an empty list. The values
    // the importer produces and the values the filters offer are two
    // vocabularies written in two files, so they are compared here.
    const valuesOf = (src, name) => {
      const i = src.indexOf(`export const ${name}`);
      if (i === -1) throw new Error(`no ${name} in lookupFilters.ts`);
      const seg = src.slice(i, src.indexOf(";", i));
      return new Set([
        ...[...seg.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]),
        ...[...seg.matchAll(/^\s*"([^"]+)",?$/gm)].map((m) => m[1]),
      ]);
    };

    // Schools: the importer expands the dnd5e abbreviations, and the
    // filter offers the expansions.
    const importerSchools = new Set(
      [
        ...foundrySrc
          .slice(foundrySrc.indexOf("const SCHOOLS"))
          .slice(0, 400)
          .matchAll(/:\s*"([^"]+)"/g),
      ].map((m) => m[1])
    );
    for (const school of valuesOf(filtersSrc, "SCHOOLS")) {
      if (!importerSchools.has(school)) {
        problems.push(
          `the School filter offers "${school}", which import-foundry.mjs ` +
            "never produces — the chip would match nothing"
        );
      }
    }

    // Item kinds: the importer's bucket vocabulary is the union of the
    // equipment map's values and the literals itemKind returns.
    const kindFn = foundrySrc.slice(
      foundrySrc.indexOf("const EQUIPMENT_KINDS"),
      foundrySrc.indexOf("function humanize")
    );
    const importerKinds = new Set(
      [...kindFn.matchAll(/"([a-z]+)"/g)].map((m) => m[1])
    );
    for (const kind of valuesOf(filtersSrc, "ITEM_KINDS")) {
      if (!importerKinds.has(kind)) {
        problems.push(
          `the Category filter offers item kind "${kind}", which ` +
            "import-foundry.mjs never produces"
        );
      }
    }

    // Caster progressions: the importer spells out dnd5e's four slugs,
    // and the filter offers the spelt-out forms. Same trap as the two
    // above — "full" on one side and "Full" on the other is a chip
    // that renders, is clickable, and returns nothing.
    const importerProgressions = new Set(
      [
        ...foundrySrc
          .slice(
            foundrySrc.indexOf("const CASTER_PROGRESSION"),
            foundrySrc.indexOf("function classToRow")
          )
          .matchAll(/:\s*"([^"]+)"/g),
      ].map((m) => m[1])
    );
    if (importerProgressions.size === 0) {
      throw new Error("read no caster progressions out of import-foundry.mjs");
    }
    for (const p of valuesOf(filtersSrc, "CASTER_PROGRESSIONS")) {
      if (!importerProgressions.has(p)) {
        problems.push(
          `the Spellcasting filter offers "${p}", which import-foundry.mjs ` +
            "never produces — the chip would match nothing"
        );
      }
    }

    // The class/subclass chips are matched against a string the FILTER
    // builds from a boolean, not against anything the importer writes —
    // so the pair that has to agree is the chip list and the matcher.
    {
      const kinds = valuesOf(filtersSrc, "CLASS_KINDS");
      const matcher = filtersSrc.slice(
        filtersSrc.indexOf("const CLASS_FILTERS"),
        filtersSrc.indexOf("const SPECIES_FILTERS")
      );
      for (const k of kinds) {
        if (!matcher.includes(`"${k}"`)) {
          problems.push(
            `CLASS_KINDS offers "${k}", which CLASS_FILTERS never produces ` +
              "from a row — the chip would match nothing"
          );
        }
      }
    }

    // Feat categories: humanize() turns dnd5e's camelCase subtypes into
    // these, so the chips have to be in the humanised form. "epicBoon"
    // becomes "Epic Boon", not "EpicBoon" or "epic boon".
    for (const c of valuesOf(filtersSrc, "FEAT_CATEGORIES")) {
      if (!/^[A-Z][a-z]*(?: [A-Z][a-z]*)*$/.test(c)) {
        problems.push(
          `the feat Category filter offers "${c}", which is not the shape ` +
            "humanize() produces — a camelCase subtype comes out Title " +
            "Cased with spaces, so this chip would match nothing"
        );
      }
    }

    // ---- the notebook's format toolbar -----------------------------
    // Two failures here are invisible to TypeScript and both present as
    // "the toolbar does nothing", which reads as a broken browser rather
    // than a broken handler:
    //
    //   - onClick instead of onMouseDown+preventDefault. The click blurs
    //     the contentEditable and collapses its selection BEFORE the
    //     handler runs, so the command applies to nothing.
    //   - calling document.execCommand directly. That changes what is on
    //     screen and nothing else; the helper is what writes the box's
    //     new HTML back through the mutation, so a direct call looks
    //     applied and is gone on reload.
    // Code only: this file documents both traps in prose, and failing on
    // the explanation would punish it for warning the next reader.
    const fmtBar = stripComments(read("components", "NotebookFormatBar.tsx"));

    if (/onClick=/.test(fmtBar)) {
      problems.push(
        "NotebookFormatBar uses onClick — a click collapses the box's " +
          "selection before the handler runs; every control must be " +
          "onMouseDown with preventDefault()"
      );
    }
    const mouseDowns = [...fmtBar.matchAll(/onMouseDown=\{\(e\) => \{/g)];
    if (mouseDowns.length === 0) {
      problems.push("NotebookFormatBar has no onMouseDown handlers at all");
    }
    const preventDefaults = [...fmtBar.matchAll(/e\.preventDefault\(\)/g)];
    if (preventDefaults.length < mouseDowns.length) {
      problems.push(
        `NotebookFormatBar has ${mouseDowns.length} onMouseDown handlers but ` +
          `only ${preventDefaults.length} preventDefault() calls — one of ` +
          "them will silently format nothing"
      );
    }
    if (/document\.execCommand/.test(fmtBar)) {
      problems.push(
        "NotebookFormatBar calls document.execCommand directly — route it " +
          "through applyScrapbookTextFormat, which also persists the result"
      );
    }
    if (!/applyScrapbookTextFormat/.test(fmtBar)) {
      problems.push("NotebookFormatBar never calls applyScrapbookTextFormat");
    }

    // A <select> must NOT preventDefault on mousedown or it cannot open;
    // it is safe because the remembered range, not the live selection, is
    // what the apply helper restores. So the toolbar has to mount the
    // tracker that remembers it.
    const nbTool = stripComments(read("components", "NotebookTool.tsx"));
    if (!/addEventListener\("selectionchange", trackScrapbookSelection\)/.test(nbTool)) {
      problems.push(
        "NotebookTool does not mount the selectionchange tracker — the " +
          "format toolbar would act on whatever the last click left behind"
      );
    }
    if (!/registerScrapbookSaver/.test(nbTool)) {
      problems.push(
        "NotebookTool never registers a saver, so formatting would be lost " +
          "on reload"
      );
    }

    // ---- the shared feedback table's contract ----------------------
    // Three apps write to one Supabase table. Getting `app` wrong files
    // bugs under the wrong product and nobody notices for weeks, and a
    // stray `status` would let the form mark its own triage state.
    const feedback = read("components", "feedbackClient.ts");

    if (!/FEEDBACK_APP = "Game Mastery"/.test(feedback)) {
      problems.push(
        'feedbackClient must submit app = "Game Mastery" exactly — the ' +
          "table's CHECK constraint allows only the three known apps"
      );
    }
    const insertBody = feedback.slice(
      feedback.indexOf("async function insertRow"),
      feedback.indexOf("// ---- the local retry queue")
    );
    if (/\bstatus\b\s*:/.test(insertBody)) {
      problems.push(
        "feedbackClient sends `status` — that is Derek's triage state and " +
          "must never be written by an app"
      );
    }
    for (const c of ["Bug Report", "Feature Request", "Suggestion", "Other"]) {
      if (!feedback.includes(`"${c}"`)) {
        problems.push(`feedback category "${c}" is missing from CATEGORIES`);
      }
    }
    if (/\bBug\b(?!\s+Report)/.test(feedback.match(/CATEGORIES = \[[^\]]*\]/)?.[0] ?? "")) {
      problems.push(
        'CATEGORIES contains a bare "Bug" — the shared table already ' +
          'drifted into holding both "Bug" and "Bug Report"'
      );
    }

    // ---- the format bar's buttons and its one popup class -----------
    // Reported as "a floating attachment icon out of place": the Link
    // button's WRAPPER wore `nb-fmt-pop`, which is the floating PANEL's
    // class, so the button inherited `top: 1.9rem`, a border and a
    // background and hung below the bar in a box of its own. Somebody
    // had then redeclared `.nb-fmt-pop` further down the stylesheet to
    // make the wrapper behave, which broke the real panel instead.
    {
      const css = read("app", "globals.css");
      const picker = stripComments(read("components", "NoteLinkPicker.tsx"));
      const bar = stripComments(read("components", "NotebookFormatBar.tsx"));

      const popRules = (css.match(/^\.nb-fmt-pop\s*\{/gm) ?? []).length;
      if (popRules !== 1) {
        problems.push(
          `globals.css declares .nb-fmt-pop ${popRules} times — two rules ` +
            "for one class is how a wrapper and a floating panel end up " +
            "sharing, and fighting over, the same properties"
        );
      }
      if (/className="nb-fmt-pop"/.test(picker)) {
        problems.push(
          "NoteLinkPicker's wrapper wears nb-fmt-pop, the floating panel's " +
            "class — the Link button would hang below the toolbar again"
        );
      }
      if (!/className="nb-fmt-pop-host"/.test(picker)) {
        problems.push(
          "NoteLinkPicker's wrapper is not nb-fmt-pop-host — its panel is " +
            "positioned against it, so without it the panel escapes"
        );
      }

      // Four buttons that were four characters, two of which had no
      // glyph in the app's fonts: the row rendered as ▤ ≡ ▤ ≡.
      for (const glyph of ["⯇", "⯈", "☰"]) {
        if (bar.includes(glyph)) {
          problems.push(
            `the format bar still labels a button "${glyph}" — the app's ` +
              "fonts have no glyph for it and the browser substitutes"
          );
        }
      }
      // Comments stripped: this file's own doc comment says "One
      // `<svg>`", and failing on a file for explaining itself is the
      // guard punishing the thing it is asking for.
      const icon = stripComments(read("components", "AlignIcon.tsx"));
      for (const kind of ["left", "center", "right", "justify"]) {
        if (!bar.includes(`<AlignIcon kind="${kind}" />`)) {
          problems.push(`the format bar has no ${kind} alignment icon`);
        }
        if (!new RegExp(`^\\s*${kind}: \\[`, "m").test(icon)) {
          problems.push(`AlignIcon draws nothing for "${kind}"`);
        }
      }
      // One <svg>, so the four cannot drift apart in stroke weight —
      // the same rule the sidebar's Glyph runs on.
      const svgs = (icon.match(/<svg\b/g) ?? []).length;
      if (svgs !== 1) {
        problems.push(
          `AlignIcon contains ${svgs} <svg> elements — four hand-written ` +
            "ones drift the first time any of them is touched"
        );
      }
      // No two of the four may draw the same picture. A copy-paste that
      // left left and right pointing the same way typechecks, renders,
      // and is only visible if you look closely at two 15px icons —
      // which is the state the CHARACTERS were in, and the whole reason
      // these are drawn.
      const barsOf = (kind) =>
        new RegExp(`\\b${kind}: \\[([^\\]]*)\\]`).exec(icon)?.[1]?.trim() ?? "";
      const drawn = new Map();
      for (const kind of ["left", "center", "right", "justify"]) {
        const bars = barsOf(kind);
        if (!bars) {
          problems.push(`AlignIcon's bar table has no readable "${kind}"`);
          continue;
        }
        const twin = drawn.get(bars);
        if (twin) {
          problems.push(
            `the ${twin} and ${kind} alignment icons draw the same bars`
          );
        }
        drawn.set(bars, kind);
      }
    }

    // ---- the DM Screen's controls live in the ribbon ----------------
    // Moved there by request: Add Window, Workspaces and the note
    // format bar are ribbon BUILTINS — arranged in Customize like
    // everything else — whose rendering the screen injects. Each link
    // in that chain fails silently on its own.
    {
      const registrySrc = read("components", "ribbonRegistry.ts");
      const barSrc2 = stripComments(read("components", "RibbonBar.tsx"));
      const screenSrc2 = stripComments(read("components", "DmScreen.tsx"));

      for (const key of ["addWindow", "workspaces", "noteFormat"]) {
        if (!new RegExp(`key: "${key}"`).test(registrySrc)) {
          problems.push(
            `ribbon builtin "${key}" is not registered — its token would ` +
              "shed itself from every saved toolbar on the next load"
          );
        }
        if (!new RegExp(`${key}:`).test(screenSrc2)) {
          problems.push(
            `DmScreen supplies no extras.${key} renderer — the ribbon ` +
              "would filter the token out and the control would not exist"
          );
        }
        if (!new RegExp(`"b:${key}"`).test(registrySrc)) {
          problems.push(
            `DEFAULT_RIBBON does not place b:${key} — a fresh account's ` +
              "DM Screen would open with no way to add a window"
          );
        }
      }
      // Add Window and Workspaces are permanent: a layout that lost
      // them is a DM Screen with no way to put windows on it.
      for (const key of ["addWindow", "workspaces"]) {
        const row = new RegExp(`key: "${key}"[^}]*`).exec(registrySrc);
        if (!row || !/permanent: true/.test(row[0])) {
          problems.push(
            `ribbon builtin "${key}" is not permanent — a saved layout ` +
              "that dropped it could never get it back"
          );
        }
      }
      // The injected tokens are filtered out where no screen supplies
      // them, or a ribbon mounted anywhere else renders mystery gaps.
      if (!/return Boolean\(extras\?\.\[tok\.slice\(2\)\]\)/.test(barSrc2)) {
        problems.push(
          "RibbonBar does not gate the injected builtins on extras — " +
            "without a renderer the token renders an empty slot"
        );
      }
      // The menus portal to the body. The ribbon scrolls horizontally,
      // and an absolutely positioned menu inside a scroll container is
      // clipped at the bar's edge — open, technically, and invisible.
      if (!/createPortal\(/.test(screenSrc2)) {
        problems.push(
          "the DM Screen's menus no longer portal out of the ribbon — " +
            "the scroll container clips them at the bar's edge"
        );
      }
      // And the screen's own toolbar row is gone — the whole point.
      if (/dm-toolbar/.test(screenSrc2)) {
        problems.push(
          "DmScreen still renders its own toolbar row under the ribbon — " +
            "the controls were asked INTO the customizable bar, not beside it"
        );
      }
    }

    // ---- the DM Screen's windows ------------------------------------
    // The registry, the geometry constants, and the two rules that keep
    // an arrangement from quietly losing pieces.
    {
      const model = read("components", "dmScreenModel.ts");
      const screenSrc = stripComments(read("components", "DmScreen.tsx"));

      // Every kind the Add menu offers must render SOMETHING: the menu
      // maps over DM_PANEL_KINDS and the content switch is hand-written,
      // so a kind added to one and forgotten in the other opens an
      // empty window with no error anywhere.
      const kinds = constArrayStrings(model, "DM_PANEL_KINDS", "dmScreenModel");
      const contentAt = screenSrc.indexOf("function PanelContent");
      if (contentAt === -1) {
        problems.push("DmScreen lost its PanelContent registry");
      } else {
        const body = screenSrc.slice(contentAt, screenSrc.indexOf("function DmNotePane"));
        for (const kind of kinds) {
          if (!body.includes(`case "${kind}"`)) {
            problems.push(
              `panel kind "${kind}" is in the Add menu but PanelContent ` +
                "has no case for it — it would open an empty window"
            );
          }
        }
        // The label alone is not the content: a deleted return leaves
        // `case "rules":` falling through into the next case, which
        // renders the WRONG window with every label present. So every
        // component the registry exists to serve must actually be
        // rendered in it. (The seven lookup kinds share LookupTool by
        // design — that is one entry here, not seven.)
        for (const el of [
          "<LookupTool",
          "<NpcTable",
          "<SessionTable",
          "<LocationsTool",
          "<GroupTable",
          "<ChatTool",
          "<CalendarTool",
          "<RulesLawyerTool",
          "<ReferencePanel",
          "<DmNotePane",
        ]) {
          if (!body.includes(el)) {
            problems.push(
              `PanelContent no longer renders ${el} — its kind's case ` +
                "falls through into a neighbour and opens the wrong window"
            );
          }
        }
      }

      // The header height is stated twice — once as CSS, once as the
      // number panelHeaderAt measures with — and a drop lands in the
      // wrong window the day they disagree.
      const cssHead = /\.dm-panel-head\s*\{[^}]*height:\s*(\d+)px/.exec(
        read("app", "globals.css")
      );
      const jsHead = /const HEADER_PX = (\d+)/.exec(screenSrc);
      if (!cssHead || !jsHead) {
        problems.push("could not read both copies of the panel header height");
      } else if (cssHead[1] !== jsHead[1]) {
        problems.push(
          `the panel header is ${cssHead[1]}px in CSS and ${jsHead[1]}px in ` +
            "the drop hit-test — dropping a tab would miss the header it " +
            "is visibly over"
        );
      }

      // The live layout autosaves, and the saver saves what is on
      // screen rather than a stale closure.
      if (!/saveLayout\(\{ campaignId, layout: serializeLayout\(layout\) \}\)/.test(screenSrc)) {
        problems.push(
          "DmScreen does not autosave the live layout — every arrangement " +
            "would be lost on reload"
        );
      }
      // A workspace LOADS through the parser, never straight into
      // state: a stored blob is exactly what parseLayout exists for.
      if (!/parseLayout\(ws\.layout, noteIds\)/.test(screenSrc)) {
        problems.push(
          "loading a workspace bypasses parseLayout — a stale snapshot " +
            "would be trusted straight into the screen"
        );
      }
    }

    // ---- the expand cell must never ellipsise, and the thank-you
    // ---- closes itself ----------------------------------------------
    {
      const css = read("app", "globals.css");
      const fb = stripComments(read("components", "FeedbackForm.tsx"));

      // The cell's own rules have to WIN. Bare `.expand-cell` loses to
      // `.npc-table td` on specificity, which left its overrides dead:
      // the cell inherited `text-overflow: ellipsis`, and at drag
      // widths between the padding box and the button's edge the
      // clipped button rendered as "…" in every row. Reported, and
      // reproduced at 46–54px before fixing.
      const cellRule = /\.npc-table td\.expand-cell\s*\{([^}]*)\}/.exec(css);
      if (!cellRule) {
        problems.push(
          "no .npc-table td.expand-cell rule — a bare .expand-cell loses " +
            "to .npc-table td and every override in it is dead"
        );
      } else {
        if (!/text-overflow:\s*clip/.test(cellRule[1])) {
          problems.push(
            "the expand cell does not clear text-overflow — a drag width " +
              "between the padding box and the button draws the button as " +
              "a \u2026"
          );
        }
        if (!/overflow:\s*visible/.test(cellRule[1])) {
          problems.push("the expand cell clips its own button again");
        }
      }
      if (/^\.expand-cell\s*\{/m.test(css)) {
        problems.push(
          "a bare .expand-cell rule is back — it loses to .npc-table td " +
            "and reads as an override while doing nothing"
        );
      }

      // The thank-you closes itself after two seconds, and the timer
      // dies with the state: a timeout that survives its window closes
      // whatever replaced it.
      const auto = /if \(state !== "sent"\) return;\s*\n\s*const t = setTimeout\(onClose, 2000\);\s*\n\s*return \(\) => clearTimeout\(t\);/;
      if (!auto.test(fb)) {
        problems.push(
          "the sent state does not auto-close in two seconds with a " +
            "cleaned-up timer — either the thank-you sits until clicked, " +
            "or a stale timeout closes whatever replaced it"
        );
      }
    }

    // ---- the second morning's reports -------------------------------
    {
      const css = read("app", "globals.css");
      const shell = stripComments(read("components", "AppShell.tsx"));
      const fb = stripComments(read("components", "FeedbackForm.tsx"));
      const detail2 = stripComments(read("components", "SessionDetail.tsx"));
      const panel2 = stripComments(read("components", "SettingsPanel.tsx"));
      const campaignsSrc2 = read("convex", "campaigns.ts");
      const sessionsSrc2 = read("convex", "sessions.ts");

      // One panel: no grid gap between the session tabs, the format
      // bar and the page, and the joins are square.
      const notesRule = css.slice(
        css.indexOf(".session-notes {"),
        css.indexOf("}", css.indexOf(".session-notes {"))
      );
      if (!/gap:\s*0[;\s]/.test(notesRule)) {
        problems.push(
          "the session notes grid has a gap again — the tabs, the bar " +
            "and the page were asked to act as one panel"
        );
      }
      // The property, not the selector: ".session-notes .nb-canvas"
      // also names the height rule, so a deleted join passed while its
      // selector lived on in an unrelated block. Mutation-tested.
      for (const [pattern, what] of [
        [/\.session-notes \.nb-fmtbar\s*\{[^}]*margin-bottom:\s*0/, "the bar keeps its gap below"],
        [/\.session-notes \.nb-canvas\s*\{[^}]*border-top-left-radius:\s*0/, "the page keeps its rounded top"],
        [/\.session-notes \.session-tabs\s*\{[^}]*border-bottom:\s*none/, "the tab strip keeps its own rule"],
      ]) {
        if (!pattern.test(css)) {
          problems.push(
            `the session panel is not joined — ${what}, so the three ` +
              "pieces read as separate windows again"
          );
        }
      }

      // The sidebar's DM pill is gone; the section itself still only
      // renders for the DM, which is what made the pill redundant.
      const titleAt = shell.indexOf("nav-group-title");
      const titleEnd = shell.indexOf("</button>", titleAt);
      if (/className="badge"/.test(shell.slice(titleAt, titleEnd))) {
        problems.push(
          "the sidebar section heading wears the DM badge again — " +
            "reported off, because the section only renders for the DM"
        );
      }

      // The thank-you fits its sentence: the shell must shrink when
      // sent, and the shrunk window must not keep the dragged height.
      if (!/shrink=\{state === "sent"\}/.test(fb)) {
        problems.push(
          "the feedback shell does not shrink on the sent state — the " +
            "one-line thank-you inherits the size of the form again"
        );
      }
      if (!/height: "auto"/.test(fb)) {
        problems.push(
          "the shrunk feedback window keeps a fixed height — auto is " +
            "what fits it to its sentence"
        );
      }

      // The expand track is adjustable and REMEMBERED: the pseudo-key
      // has to survive both stores' load paths, or the divider works
      // until the page is refreshed.
      if (!/known\.add\("expand"\)/.test(read("components", "useLookupLayout.ts"))) {
        problems.push(
          "useLookupLayout drops the \"expand\" pseudo-key on load — the " +
            "Lookup divider would save and then vanish on refresh"
        );
      }
      // BOTH halves of the round trip, because "_expand" appearing
      // anywhere satisfies neither: a mutation renamed only the save
      // key and the file still contained the string, in the load path
      // that would now never find anything.
      const prefsSrc = stripComments(read("components", "useViewPrefs.ts"));
      if (!/\{ key: "_expand", width: expandWidth/.test(prefsSrc)) {
        problems.push(
          "useViewPrefs does not save the _expand pseudo-column — the " +
            "table dividers would not survive a reload"
        );
      }
      if (!/c\.key === "_expand"/.test(prefsSrc)) {
        problems.push(
          "useViewPrefs never reads the _expand pseudo-column back — " +
            "saved dividers would load as nothing"
        );
      }
      for (const file of ["NpcTable.tsx", "SessionTable.tsx", "GroupTable.tsx"]) {
        const src = stripComments(read("components", file));
        // The CALL SITE, not the function: a handle whose onPointerDown
        // was emptied still defines startExpandResize a page up.
        if (
          !/onPointerDown=\{\(e\) => startExpandResize\(e\)\}/.test(src) ||
          !/prefs\.expandWidth \?\? EXPAND_COL/.test(src)
        ) {
          problems.push(
            `${file} has no adjustable expand column — asked for on ` +
              "every table in the app"
          );
        }
      }

      // Leveling: the schema stores it, the DM can set it, the session
      // validates the level, and the settings tab offers the choice.
      if (!/leveling: v\.optional\(v\.union\(v\.literal\("xp"\), v\.literal\("milestone"\)\)\)/.test(read("convex", "schema.ts"))) {
        problems.push("campaigns.leveling is not in the schema");
      }
      if (!/export const setLeveling = mutation/.test(campaignsSrc2)) {
        problems.push("campaigns.setLeveling is gone — nobody can switch modes");
      }
      const setLevelingBody = campaignsSrc2.slice(
        campaignsSrc2.indexOf("export const setLeveling"),
        campaignsSrc2.indexOf("export const", campaignsSrc2.indexOf("export const setLeveling") + 10)
      );
      if (!/requireDm\(/.test(setLevelingBody)) {
        problems.push("setLeveling is not gated on requireDm");
      }
      if (!/A milestone is a level from 2 to 20/.test(sessionsSrc2)) {
        problems.push(
          "updateSession no longer validates the milestone — a typo " +
            "level 200 would store and sort"
        );
      }
      if (!/setLeveling\(\{ campaignId, leveling: m\.value \}\)/.test(panel2)) {
        problems.push(
          "the Campaign settings tab has no leveling choice — the mode " +
            "exists and nobody can reach it"
        );
      }
      // The dropdown gets its options from the one function that knows
      // the rule, fed with every session.
      if (!/milestoneOptions\(/.test(detail2)) {
        problems.push(
          "SessionDetail does not compute the milestone options — the " +
            "dropdown would offer levels the campaign already reached"
        );
      }
    }

    // ---- three reports from one morning ------------------------------
    // The session title opens the record, the name column is sized by
    // its contents, and two sentences are gone. Each check pins the
    // specific thing reported, because each is a change a later edit
    // could quietly undo while everything still rendered.
    {
      const sessionsSrc = stripComments(read("components", "SessionTable.tsx"));
      const sessionCols = read("components", "sessionColumns.ts");
      const lookupSrc = stripComments(read("components", "LookupTool.tsx"));
      const css = read("app", "globals.css");
      const npcDetail = read("components", "NpcDetail.tsx");
      const registry = read("components", "uiRegistry.ts");

      // The title is the way in. An editable number cell meant a click
      // on "Session 40" turned the label into an input — the row
      // refusing to open.
      const numberCol = sessionCols.slice(
        sessionCols.indexOf('key: "number"'),
        sessionCols.indexOf('key: "date"')
      );
      if (!/editable: false/.test(numberCol)) {
        problems.push(
          "the session number column is list-editable again — clicking " +
            "the title would edit in place instead of opening the session"
        );
      }
      // The cell's own markup, bounded to its td. The first version of
      // this check was a tangle of fallbacks that passed with the
      // onClick deleted — mutation-tested, caught, rewritten plainly.
      const titleAt = sessionsSrc.indexOf('className="name-cell session-title"');
      if (titleAt === -1) {
        problems.push("the session title cell lost its class — the gap and cursor rules aim at it");
      } else {
        const cell = sessionsSrc.slice(titleAt, sessionsSrc.indexOf(">", titleAt));
        if (!cell.includes("onClick={onOpen}")) {
          problems.push(
            "the session title cell does not open the record on click"
          );
        }
      }
      // And the record must still be able to renumber, or the number
      // is editable nowhere. SessionDetail renders every column
      // editable from isDm, not from the flag — checked, not assumed.
      const detail = stripComments(read("components", "SessionDetail.tsx"));
      if (!/editable=\{isDm\}/.test(detail)) {
        problems.push(
          "SessionDetail no longer gates fields on isDm alone — with the " +
            "list's inline edit gone, the number would be editable nowhere"
        );
      }
      if (!/\.session-table td\.session-title\s*\{[^}]*padding-left/.test(css)) {
        problems.push(
          "no breathing room between the expand button and the session " +
            "title — the gap rule is gone"
        );
      }

      // The name column is measured over the rows on the tab, and a
      // dragged width still wins — the spread order IS the feature.
      if (!/\{ name: nameWidth, \.\.\.layout\.widths \}/.test(lookupSrc)) {
        problems.push(
          "LookupTool does not lay the person's dragged widths over the " +
            "measured name default — either the measurement is gone or it " +
            "would overwrite what somebody chose"
        );
      }
      if (!/nameTrackPx\(/.test(lookupSrc)) {
        problems.push(
          "LookupTool never measures the names — the Name column is back " +
            "to its declared track on every tab"
        );
      }

      // Two sentences, removed by name. The registry guard checks ids
      // agree in both directions; this checks the WORDS are gone, so a
      // rephrasing that keeps the sentence under a new id still fails.
      for (const gone of [
        "Everyone at the table writes here",
        "You can edit Player Notes",
      ]) {
        for (const [file, src] of [
          ["NpcDetail.tsx", npcDetail],
          ["uiRegistry.ts", registry],
        ]) {
          if (src.includes(gone)) {
            problems.push(
              `${file} still says "${gone}…" — reported for removal`
            );
          }
        }
      }
      // The DM pane's own line stays: it is a promise, not an
      // explanation, and nothing asked for it to go.
      if (!/record\.notes\.dm\.blurb/.test(npcDetail)) {
        problems.push(
          "the DM notes pane lost its blurb too — only the player-facing " +
            "sentences were reported"
        );
      }
    }

    // ---- the editions are buttons, and the books are switches -------
    // Two features that both narrow the Lookup tables, and both fail
    // the same silent way: the control renders, and the pipeline it is
    // meant to drive still does what it always did.
    {
      const tool = stripComments(read("components", "LookupTool.tsx"));
      const tabsSrc = read("components", "settingsTabs.ts");
      const panel = stripComments(read("components", "SettingsPanel.tsx"));
      const registry = read("components", "uiRegistry.ts");
      const settings = read("convex", "settings.ts");
      const schema = read("convex", "schema.ts");

      // The old single-edition call has to be GONE from the screen, not
      // merely joined by the new one: leaving it would filter to the
      // campaign's edition first and hand applyEditions a library the
      // buttons can no longer widen.
      if (/\bapplyEdition\(/.test(tool)) {
        problems.push(
          "LookupTool still calls applyEdition — the buttons could not " +
            "reveal the other edition, because it would already be gone"
        );
      }
      for (const [call, why] of [
        ["applyEditions(", "the edition buttons drive nothing"],
        // The SEEDING, not merely the call: the initial useState value
        // also calls defaultEditions, so a check for the name alone was
        // satisfied while the line that reads the campaign's own
        // edition had been replaced with a constant.
        [
          "setEditions(defaultEditions(edition))",
          "the buttons would not start on this campaign's edition — rules " +
            "2 and 3 of what was asked for",
        ],
        ["applySourceFilter(", "books switched off in Settings would still appear"],
      ]) {
        if (!tool.includes(call)) {
          problems.push(`LookupTool never calls ${call} — ${why}`);
        }
      }
      // Both buttons, and both labelled from the one place that names
      // an edition — "5e" and "5.5e" typed here would drift from the
      // campaign setting that uses the same words.
      if (!/EDITION_LABEL\[/.test(tool)) {
        problems.push(
          "the edition buttons do not read EDITION_LABEL — their wording " +
            "would drift from the campaign setting that names the same two " +
            "editions"
        );
      }
      if (!/aria-pressed=\{editions\[e\]\}/.test(tool)) {
        problems.push(
          "the edition buttons do not report their own state — a toggle " +
            "that looks pressed and says nothing is a button to a screen " +
            "reader"
        );
      }

      // A tab has to exist in the registry AND have a panel, which is
      // the whole reason settingsTabs.ts is a declaration.
      if (!/id: "sources"/.test(tabsSrc)) {
        problems.push("settingsTabs has no Sources tab");
      }
      if (!/tab === "sources"/.test(panel) || !/<SourcesPanel\b/.test(panel)) {
        problems.push(
          "the Sources tab has no panel — it would render an empty page"
        );
      }
      if (!/settings\.tab\.sources/.test(registry)) {
        problems.push(
          "settings.tab.sources is not in the UI registry, so the tab " +
            "strip would render a blank label"
        );
      }

      // And the setting has to survive a reload.
      if (!/excludedSources: v\.optional\(v\.array\(v\.string\(\)\)\)/.test(schema)) {
        problems.push("userSettings has nowhere to keep excludedSources");
      }
      for (const [where, why] of [
        ["excludedSources: v.optional(v.array(v.string()))", "saveMySettings will not accept it"],
        ["excludedSources: doc.excludedSources", "mySettings never reports it back"],
        ["excludedSources: args.excludedSources ?? existing.excludedSources", "an existing row is never updated"],
      ]) {
        if (!settings.includes(where)) {
          problems.push(`convex/settings.ts is missing \`${where}\` — ${why}`);
        }
      }
      // `??` and not `||`: switching the last book back on sends an
      // EMPTY array, and `||` would read that as "did not mention it"
      // and leave every book switched off with no way back.
      if (/excludedSources: args\.excludedSources \|\|/.test(settings)) {
        problems.push(
          "saveMySettings falls back on `||` for excludedSources — an empty " +
            "list is a real request, and this would refuse to store it"
        );
      }
    }

    // ---- typing # in the notes --------------------------------------
    // The picker at the caret. Everything below is a way for it to look
    // exactly right and insert nothing, which is how the toolbar's own
    // Link button behaved before the same three rules were applied to
    // it — so they are checked rather than remembered.
    {
      const mentions = stripComments(read("components", "NoteMentions.tsx"));
      const detail = stripComments(read("components", "SessionDetail.tsx"));
      const css = read("app", "globals.css");

      if (!/<NoteMentions\b/.test(detail)) {
        problems.push(
          "the session notes do not mount NoteMentions — typing # would " +
            "do nothing"
        );
      }

      // A click moves focus out of the box and collapses the selection
      // BEFORE the handler runs, so the option has to be taken on
      // mousedown with the default prevented. Same rule as every button
      // on the format bar, and the same silent failure without it.
      if (/onClick=/.test(mentions)) {
        problems.push(
          "NoteMentions takes an option on click — the caret is gone by " +
            "then, and the link would be inserted nowhere"
        );
      }
      if (!/onMouseDown=\{\(e\) => \{\s*\n\s*e\.preventDefault\(\);/.test(mentions)) {
        problems.push(
          "NoteMentions does not prevent the default on mousedown, which " +
            "is what keeps the selection alive long enough to replace it"
        );
      }

      // The selection has to BE the `#…` being replaced, and the shared
      // helper has to be told so. Without the track call the insert
      // lands wherever the caret was last seen — usually a character to
      // the left, occasionally in a different box.
      for (const [call, why] of [
        [
          "trackScrapbookSelection()",
          "the range it just built is not handed to the format helper, so " +
            "the link replaces whatever was tracked before",
        ],
        [
          "insertScrapbookHtml(",
          "nothing inserts the link, and nothing writes the box back",
        ],
        [
          "exactTarget(",
          'a finished name does not link itself — "#Kelja Ironfist" would ' +
            "need a keypress it was promised it would not",
        ],
        [
          "readHashQuery(",
          "nothing reads what has been typed after the #",
        ],
      ]) {
        if (!mentions.includes(call)) {
          problems.push(`NoteMentions never calls ${call} — ${why}`);
        }
      }

      // The caret lands OUTSIDE the anchor, or the rest of the sentence
      // becomes part of the link. A plain space is collapsed away by
      // insertHTML and leaves the caret inside.
      if (!/&nbsp;/.test(mentions)) {
        problems.push(
          "NoteMentions inserts no trailing non-breaking space — the caret " +
            "stays inside the anchor and the next word typed joins the link"
        );
      }

      // Blue and underlined, in a box and on the page. The app's global
      // `a { color: inherit; text-decoration: none }` is what this is
      // overriding, so losing the rule is losing the appearance.
      const linkRule = css.slice(
        css.indexOf(".nb-text a[data-gm]"),
        css.indexOf("}", css.indexOf(".nb-text a[data-gm]"))
      );
      if (!/color:\s*var\(--link\)/.test(linkRule)) {
        problems.push(
          "a link in the notes is not painted with --link — it inherits " +
            "the app's own `color: inherit` and stops looking like a link"
        );
      }
      if (!/text-decoration:\s*underline/.test(linkRule)) {
        problems.push("a link in the notes is not underlined");
      }
      if (!/\.nb-page a\[data-gm\]/.test(css)) {
        problems.push(
          "the rule covers text boxes but not the page — most notes are " +
            "written on the page now"
        );
      }
      // Every palette, or a theme somewhere paints links with nothing.
      const palettes = (css.match(/--link:/g) ?? []).length;
      const themes = (css.match(/^\[data-theme="/gm) ?? []).length + 1;
      if (palettes !== themes) {
        problems.push(
          `--link is defined in ${palettes} of ${themes} palettes — the ` +
            "ones without it paint links with an empty custom property"
        );
      }
    }

    // ---- a species heading, which is not one of its own printings ---
    // It has no document, so it had no picture — leaving the rows that
    // HAVE variants as the only blank squares in a table of artwork,
    // and those are the rows people look for first.
    {
      const fields = read("components", "lookupFields.ts");
      const tool = stripComments(read("components", "LookupTool.tsx"));
      const css = read("app", "globals.css");

      if (!/image: familyImage\(list\)/.test(fields)) {
        problems.push(
          "a species family heading carries no image — every other row in " +
            "the table has one, so the headings read as species nobody drew"
        );
      }
      // The Player's Handbook first: it is the picture OF the species
      // rather than of one version of it.
      const picker = blockAfter(
        fields,
        /export function familyImage/,
        "familyImage"
      );
      if (!/bookRank\(/.test(picker)) {
        problems.push(
          "familyImage does not rank the books — it would take whichever " +
            "printing happened to sort first rather than the PHB one"
        );
      }
      if (!/const book = String/.test(fields) || !/"PHB"/.test(fields)) {
        problems.push("bookRank no longer knows what the PHB is");
      }

      // What counts as a printing on the end of a book — "PHB 2024",
      // "SRD 5.1" — is stated twice: expandSource takes it off to find
      // the book, and the unknown-sources report takes it off to decide
      // whether the app already knows that book. They disagreed within
      // a minute of the second one being written, and the symptom was
      // a report listing books that expand perfectly well.
      const printing = (src, label) => {
        const m = /\/\^\(\.\*\\S\)\\s\+\(.*?\)\$\//.exec(src);
        if (!m) throw new Error(`no printing pattern in ${label}`);
        return m[0];
      };
      const inApp = printing(
        read("components", "sourceNames.ts"),
        "sourceNames.ts"
      );
      const inReport = printing(
        read("scripts", "unknown-sources.mjs"),
        "unknown-sources.mjs"
      );
      if (inApp !== inReport) {
        problems.push(
          `the app strips a printing with ${inApp} and the sources report ` +
            `with ${inReport} — the report would list books the column ` +
            "already writes out in full"
        );
      }

      // "4 Variants", not "Variants 4". The count leads.
      const heading = tool.slice(
        tool.indexOf('<h3 className="lk-h">', tool.indexOf("function FamilyList")),
        tool.indexOf("</h3>", tool.indexOf("function FamilyList"))
      );
      const countAt = heading.indexOf("lk-subclass-count");
      const labelAt = heading.indexOf("FAMILY_LABEL");
      if (countAt === -1 || labelAt === -1 || countAt > labelAt) {
        problems.push(
          "the variant count does not lead its heading — a pill trailing " +
            "the word is a number you read second and attach yourself"
        );
      }

      // And the rule above that heading, which separated it from
      // nothing at all on a panel where the list is the whole content.
      if (!/\.lk \.lk-subclasses:first-child\s*\{[^}]*border-top:\s*none/.test(css)) {
        problems.push(
          "globals.css does not drop the rule above a variants list that " +
            "leads its panel — it was a line with nothing above it"
        );
      }
    }

    // ---- the feedback window floats, and photographs what is under it
    // Reported: it dimmed and blocked the screen it was asking you to
    // describe. It is now a window — movable, resizable, no scrim —
    // with two capture buttons, and every one of the checks below is a
    // failure that looks fine in a screenshot of the happy path.
    {
      const form = read("components", "FeedbackForm.tsx");
      const code = stripComments(form);
      const grab = read("components", "screenGrab.ts");
      const css = read("app", "globals.css");

      if (/drawer-scrim/.test(code)) {
        problems.push(
          "the feedback window renders a scrim — it must not dim or block " +
            "the screen the report is about, which is the whole reason it " +
            "moves"
        );
      }

      const modal = (() => {
        const at = css.indexOf(".feedback-modal {");
        if (at === -1) throw new Error("no .feedback-modal rule in globals.css");
        return css.slice(at, css.indexOf("}", at));
      })();
      if (!/position:\s*fixed/.test(modal)) {
        problems.push(".feedback-modal is not position: fixed");
      }
      // Position and size come from the drag, inline. A stylesheet that
      // also has an opinion wins on specificity for `transform` and
      // loses silently for the rest: the window then sits half a window
      // away from the pointer, or refuses to resize at all.
      for (const prop of ["top", "left", "transform", "width", "height"]) {
        if (new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(modal)) {
          problems.push(
            `.feedback-modal sets ${prop} in CSS — the window's position ` +
              "and size are set inline from the drag, and a stylesheet " +
              "value here fights them"
          );
        }
      }

      // The element that gets hidden for a capture has to be the window
      // itself. Hiding the wrong node produces a screenshot of the bug
      // report sitting on top of the bug.
      const tag = code.slice(
        code.indexOf('className="feedback-modal"') - 200,
        code.indexOf('className="feedback-modal"') + 400
      );
      const refName = /ref=\{(\w+)\}/.exec(tag)?.[1];
      if (!refName) {
        problems.push(
          "the .feedback-modal element carries no ref — nothing can hide " +
            "it for a capture"
        );
      } else if (
        !new RegExp(`grabScreen\\(\\s*${refName}\\.current\\s*\\)`).test(code)
      ) {
        problems.push(
          `the feedback window is held in \`${refName}\` but that is not ` +
            "what is passed to grabScreen — a capture would leave the " +
            "report itself in the picture"
        );
      }

      // One adder, so the six-attachment cap and the duplicate check
      // apply to captures as well as to picked files. Two writes are
      // expected: the adder, and Remove.
      const writes = (code.match(/setShots\(/g) ?? []).length;
      if (writes !== 2) {
        problems.push(
          `FeedbackForm writes shots from ${writes} places — every ` +
            "screenshot must go through the one adder, or a capture is the " +
            "path that goes past " +
            "the cap"
        );
      }
      const adder = code.slice(
        code.indexOf("const addShots"),
        code.indexOf("async function capture")
      );
      if (!/SHOT_MAX/.test(adder) || !/f\.name === file\.name/.test(adder)) {
        problems.push(
          "the shot adder no longer applies both the cap and the " +
            "name-and-size duplicate check"
        );
      }
      for (const kind of ['capture("page")', 'capture("area")']) {
        if (!code.includes(kind)) {
          problems.push(`the feedback window has no ${kind} button`);
        }
      }
      // Past the imports, so that merely importing the check does not
      // satisfy the guard — the gate has to be computed and used.
      const afterImports = code.slice(code.indexOf("const SHOT_MAX"));
      if (!/canGrabScreen/.test(afterImports)) {
        problems.push(
          "nothing gates the capture buttons on the browser being able to " +
            "capture — in a browser that cannot, they would be two buttons " +
            "that do nothing"
        );
      }

      // The marquee is drawn in the viewport's pixels and the picture is
      // in the screen's. Cropping with the raw rectangle cuts out a
      // region near the right one and nowhere near obviously wrong.
      const cut = /const (\w+)\s*=\s*toNatural\(/.exec(code)?.[1];
      if (!cut) {
        problems.push(
          "the area crop does not go through toNatural — a rectangle drawn " +
            "on screen is not a rectangle in the captured image"
        );
      } else if (!new RegExp(`cropBlob\\([^)]*\\b${cut}\\b`).test(code)) {
        problems.push(
          `toNatural's result (\`${cut}\`) is not what cropBlob is given`
        );
      }

      // Two frames, not one: the first can arrive before the browser has
      // finished compositing the hidden window away.
      if ((grab.match(/await nextFrame\(\)/g) ?? []).length < 2) {
        problems.push(
          "grabScreen waits one frame after hiding the window — the first " +
            "frame can still contain it"
        );
      }
      const cleanup = grab.slice(grab.indexOf("} finally {"), grab.length);
      if (
        !/visibility = previous/.test(cleanup) ||
        !/getTracks\(\)/.test(cleanup)
      ) {
        problems.push(
          "grabScreen does not both restore the window and stop the stream " +
            "in its finally — a thrown capture would leave the window " +
            "invisible, or the browser sharing the screen with nobody " +
            "watching"
        );
      }
    }

    return problems;
  },
};

/**
 * Hook calls an earlier return can skip.
 *
 * Parsed with TypeScript's own parser rather than scanned with a regex.
 * The hand-rolled version of this counted braces to find scope
 * boundaries and got it wrong four times in a row — named nested
 * functions, object accessors, an arrow whose body started on the next
 * line, and finally a brace count that unbalanced somewhere in the JSX
 * and made the whole file scan stop early while still reporting clean.
 * A guard that quietly checks nothing is the thing this suite exists to
 * prevent, and `typescript` is already a dependency.
 */
function conditionalHooks(fileName, source) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found = [];

  const isHookCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    /^use[A-Z]/.test(node.expression.text);

  const opensItsOwnScope = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isClassDeclaration(node);

  /** One function's own body, with nested scopes checked separately. */
  const checkScope = (body) => {
    let sawReturn = false;
    const visit = (node) => {
      if (opensItsOwnScope(node)) {
        // Its returns are ITS returns, not this function's.
        if (node.body) checkScope(node.body);
        return;
      }
      if (sawReturn && isHookCall(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({
          line: line + 1,
          text: node.getText(sf).split("\n")[0].slice(0, 70),
        });
      }
      ts.forEachChild(node, visit);
      // Set AFTER descending, so a hook INSIDE the returned expression
      // — `return useContext(X) ?? SHIPPED`, the whole body of a
      // one-line hook wrapper — runs AT the return, not after it.
      if (ts.isReturnStatement(node)) sawReturn = true;
    };
    ts.forEachChild(body, visit);
  };

  const top = (node) => {
    if (opensItsOwnScope(node)) {
      if (node.body) checkScope(node.body);
      return;
    }
    ts.forEachChild(node, top);
  };
  ts.forEachChild(sf, top);

  return found;
}

/**
 * State updaters that exist only for their side effect.
 *
 * `setX((v) => { doSomething(); return v; })` returns the value it was
 * given, so it updates nothing — it is a way to READ current state. But
 * React runs updaters during the render phase, so `doSomething()` runs
 * mid-render, and if it touches state anywhere the whole tree complains.
 * Found in NotebookTool, where dragging a scrapbook box wrote its new
 * position from inside one.
 */
function sideEffectUpdaters(fileName, source) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^set[A-Z]/.test(node.expression.text) &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      if (
        ts.isArrowFunction(arg) &&
        arg.parameters.length === 1 &&
        ts.isIdentifier(arg.parameters[0].name) &&
        arg.body &&
        ts.isBlock(arg.body)
      ) {
        const param = arg.parameters[0].name.text;
        const statements = arg.body.statements;
        const last = statements[statements.length - 1];
        // More than one statement, and the last hands the argument back
        // untouched: the others are the point, and they are the bug.
        if (
          statements.length > 1 &&
          last &&
          ts.isReturnStatement(last) &&
          last.expression &&
          ts.isIdentifier(last.expression) &&
          last.expression.text === param
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push({ line: line + 1, setter: node.expression.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}
