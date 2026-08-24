"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Block,
  Feature,
  LOOKUP_COLUMNS,
  LOOKUP_TITLES,
  LookupKind,
  abilityCells,
  artSrc,
  buildFacts,
  ABSENT_PARENT_ID,
  FAMILY_LABEL,
  buildSubtitle,
  familyRows,
  columnTemplate,
  blocks as readBlocks,
  features,
  itemFacts,
  itemSubtitle,
  monsterSubtitle,
  monsterTraitLines,
  sortByColumn,
  spellCells,
  splitSource,
} from "@/components/lookupFields";
import {
  FilterState,
  RulesVersion,
  applyEdition,
  applyFilters,
} from "@/components/lookupFilters";
import { LookupFilterBar } from "@/components/LookupFilterBar";
import { useLookupLayout } from "@/components/useLookupLayout";

/**
 * The Lookup screens: spells, items, monsters, feats, backgrounds,
 * classes and species.
 *
 * A full-width table with sortable columns, where a row expands
 * DOWNWARD in place to show the whole entry. Expanding in the list
 * rather than opening a side panel is what lets you compare two things
 * — open both, and they sit in the table with the rows you were
 * scanning still around them.
 *
 * One component for every kind. The columns, the filters and the
 * expanded layout are all declarations elsewhere, so this file is the
 * shape of the screen rather than seven screens in a trench coat —
 * which is why adding four kinds touched the declarations and barely
 * touched this.
 *
 * The 5e/5.5e rule is applied here, once, for all of them: a name that
 * exists in both printings collapses to the one this campaign plays.
 * It reads only `name` and `source`, so every kind gets it by carrying
 * those two fields rather than by opting in.
 *
 * The whole lightweight index is fetched once and filtered in memory.
 * That is the cheap option here rather than the expensive one, because
 * this data has no write path and a subscription to it delivers once
 * and then sits silent — see convex/lookup.ts. The full row, with its
 * description and stat block, is fetched by id only when a row is
 * actually opened.
 */

/** How many rows the table draws before asking you to narrow down. */
const MAX_ROWS = 300;

export function LookupTool({
  kind,
  campaignId,
}: {
  kind: LookupKind;
  campaignId: Id<"campaigns">;
}) {
  const [filters, setFilters] = useState<FilterState>({});
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({
    key: "name",
    desc: false,
  });
  // A Set rather than one id: comparing two spells means having both
  // open at once, which a single-selection panel cannot do.
  const [open, setOpen] = useState<Set<string>>(new Set());

  /* ?open=<name> — how another screen sends you to one entry.
     A NAME rather than an id, because the caller is an NPC row whose
     Species field is free text somebody typed into Airtable. It may
     match nothing, and that is a normal outcome: you land on the list
     rather than on an error. */
  const params = useSearchParams();
  const openName = params.get("open");

  /* One `useQuery` per kind, all but one skipped.
     Hooks cannot be called conditionally or in a varying order, so
     this cannot become a lookup keyed on `kind` — the alternative is
     seven components with the same body. A skipped query costs
     nothing: Convex does not subscribe it. */
  const spells = useQuery(api.lookup.indexSpells, kind === "spells" ? {} : "skip");
  const items = useQuery(api.lookup.indexItems, kind === "items" ? {} : "skip");
  const monsters = useQuery(
    api.lookup.indexMonsters,
    kind === "monsters" ? {} : "skip"
  );
  const feats = useQuery(api.lookup.indexFeats, kind === "feats" ? {} : "skip");
  const backgrounds = useQuery(
    api.lookup.indexBackgrounds,
    kind === "backgrounds" ? {} : "skip"
  );
  const classes = useQuery(
    api.lookup.indexClasses,
    kind === "classes" ? {} : "skip"
  );
  const species = useQuery(
    api.lookup.indexSpecies,
    kind === "species" ? {} : "skip"
  );

  /* Keyed rather than chained. The chain it replaced ended in a bare
     `: monsters`, so every kind added after it silently rendered the
     monster list instead of its own — a screen full of the wrong data
     and no error anywhere. */
  const index = {
    spells,
    items,
    monsters,
    feats,
    backgrounds,
    classes,
    species,
  }[kind];
  const all = useMemo(
    () => (index?.rows ?? []) as Record<string, unknown>[],
    [index]
  );

  // The campaign's edition. myCampaigns is already loaded by AppShell,
  // so this is the same subscription rather than a second one.
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const edition: RulesVersion =
    campaigns?.find((c) => c._id === campaignId)?.rulesVersion ?? "2014";

  // Applied BEFORE the filters, so the counts in the bar describe the
  // library this campaign actually plays with rather than both editions
  // stacked on top of each other.
  const library = useMemo(
    () => applyEdition(all, edition, kind),
    [all, edition, kind]
  );
  const folded = all.length - library.length;

  /* Classes and species: the table lists the PARENTS, and each one
     carries its children inside its own entry. An alphabetised pile is
     not a list of the things you choose between — it puts Aberrant
     Sorcery above Barbarian, and Astral Elf above Dwarf. */
  const grouped = useMemo(() => familyRows(kind, library), [kind, library]);
  const listed = grouped ? grouped.rows : library;

  /**
   * How many children a row folds in, for the count beside its name.
   *
   * Keyed on the CLEANED name, because that is what the grouping keys
   * on — a row called "Elf (PHB)" is filed under "elf", and looking it
   * up by its raw name finds nothing and shows no count.
   */
  const memberCount = (row: Record<string, unknown>) =>
    grouped?.childrenOf.get(
      splitSource(row.name, row.source)
        .name.trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
    )?.length ?? 0;

  const matched = useMemo(
    () =>
      sortByColumn(
        kind,
        applyFilters(kind, listed, filters),
        sort.key,
        sort.desc
      ),
    // `listed`, not `library` — it is what the memo actually reads, and
    // on the classes tab the two are different arrays.
    [kind, listed, filters, sort]
  );
  const shown = matched.slice(0, MAX_ROWS);

  /* Opened ONCE, when the row it names is actually there.
     `all` is empty until the query resolves, so this cannot act on
     mount. It must also not act twice: the effect depends on `all`,
     and any re-delivery of that array would reopen the entry the
     moment you closed it — a row you cannot get rid of. The ref
     records which name has been handled, which is a fact about this
     visit rather than about the data. */
  const handledOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!openName || all.length === 0) return;
    if (handledOpen.current === openName) return;
    const want = openName.replace(/\s+/g, " ").trim().toLowerCase();
    const found = all.find(
      (r) => String(r.name ?? "").replace(/\s+/g, " ").trim().toLowerCase() === want
    );
    // Only marked handled once the row EXISTS. The index may still be
    // filling in; giving up on the first pass would land you on the
    // list with no explanation.
    if (!found) return;
    handledOpen.current = openName;
    const id = String(found._id);
    setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, [openName, all]);

  const layout = useLookupLayout(campaignId, kind);

  const columns = LOOKUP_COLUMNS[kind];
  // ONE template, shared by the header and every row. They are separate
  // grids, so anything that changes a track has to change both or the
  // columns walk away from their headings.
  const template = columnTemplate(kind, layout.widths);

  /**
   * Drag a column's right-hand border.
   *
   * The starting width is measured off the rendered header cell rather
   * than read from stored widths: a column nobody has touched is a `fr`
   * or a `rem`, and there is no pixel value to start from until the
   * browser has laid it out.
   */
  const startResize = (key: string, event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const cell = event.currentTarget.parentElement;
    if (!cell) return;

    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;

    const onMove = (e: PointerEvent) => {
      layout.resize(key, startWidth + (e.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("col-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("col-resizing");
  };

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sortBy = (key: string) =>
    setSort((prev) =>
      // Clicking the sorted column reverses it; clicking another starts
      // that one ascending, which is what a first click should mean.
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: false }
    );

  const loading = index === undefined;
  const empty = !loading && all.length === 0;
  // Never truncate silently. If the library outgrew what one query can
  // read, the screen says which rows are missing and why.
  const capped = index?.capped === true;

  return (
    <div className="lookup">
      {loading ? (
        <p className="centered-note">Loading the library…</p>
      ) : empty ? (
        /* An import that never ran and a filter that matched nothing
           look identical otherwise, and the fix for each is different. */
        <p className="centered-note">
          No {LOOKUP_TITLES[kind].toLowerCase()} imported yet. They are loaded
          from a Foundry export — see Step 9c in SETUP-CONVEX.md.
        </p>
      ) : (
        <>
          <LookupFilterBar
            kind={kind}
            state={filters}
            setState={setFilters}
            matched={matched.length}
            total={listed.length}
          />

          {/* Never a silently shorter list: the edition is a campaign
              setting made somewhere else, so the screen it changes has
              to say which one is in force and what it cost. */}
          {folded > 0 && (
            <p className="muted lk-edition">
              {edition === "2024" ? "5.5e (2024)" : "5e (2014)"} — {folded}{" "}
              {folded === 1 ? "entry" : "entries"} from the other edition
              folded away. Change it in Settings.
            </p>
          )}

          {capped && (
            <p className="form-error lk-capped">
              This library is larger than one query can read, so only the
              first {all.length} {LOOKUP_TITLES[kind].toLowerCase()} are
              loaded — alphabetically, so the end of the alphabet is
              missing. Tell Claude and the text can be split into its own
              table to lift the limit.
            </p>
          )}

          <div className="lk-table">
            <div
              className="lk-head"
              style={{ ["--lk-cols" as string]: template }}
            >
              {columns.map((c) => (
                <span key={c.key} className="lk-th-cell">
                  <button
                    type="button"
                    className={`lk-th${c.align === "center" ? " center" : ""}${
                      sort.key === c.key ? " sorted" : ""
                    }`}
                    onClick={() => sortBy(c.key)}
                  >
                    <span className="lk-th-label">{c.label}</span>
                    <span className="lk-arrow">
                      {sort.key === c.key ? (sort.desc ? "▾" : "▴") : "⇅"}
                    </span>
                  </button>
                  {/* A separate element rather than an edge of the
                      button: the button sorts on click, and a drag that
                      began on it would sort when you let go. */}
                  <span
                    className="lk-col-resize"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${c.label}`}
                    title="Drag to resize · double-click to reset"
                    onPointerDown={(e) => startResize(c.key, e)}
                    onDoubleClick={() => layout.reset(c.key)}
                  />
                </span>
              ))}
              <span />
            </div>

            <div className="lk-rows">
              {shown.length === 0 && (
                <p className="muted lookup-hint">
                  Nothing matches those filters.
                </p>
              )}

              {shown.map((row) => {
                const id = String(row._id);
                const isOpen = open.has(id);
                return (
                  <div
                    key={id}
                    className={`lk-entry${isOpen ? " open" : ""}`}
                  >
                    <div
                      className="lk-tr"
                      style={{ ["--lk-cols" as string]: template }}
                      onClick={() => toggle(id)}
                    >
                      {columns.map((c) => (
                        <span
                          key={c.key}
                          className={`lk-td${
                            c.align === "center" ? " center" : ""
                          }${c.primary ? " primary" : ""}`}
                        >
                          {c.primary && <Art row={row} className="lk-art" />}
                          {c.primary ? (
                            /* The source used to sit under the name as
                               a grey sub-line, which made it
                               unsortable, unfilterable, and part of
                               the widest column on the screen. It is a
                               column of its own now. */
                            <span className="lk-name-cell">
                              <span className="lk-cell">
                                {c.get(row) ?? "—"}
                              </span>
                              {/* How many variants are folded in here,
                                  answerable without opening the row —
                                  which is the question you are asking
                                  while scanning the list. */}
                              {memberCount(row) > 0 && (
                                <span className="lk-fam-count">
                                  {memberCount(row)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="lk-cell">{c.get(row) ?? "—"}</span>
                          )}
                        </span>
                      ))}
                      <button
                        type="button"
                        className="lk-expand"
                        aria-label={isOpen ? "Collapse" : "Expand"}
                        aria-expanded={isOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(id);
                        }}
                      >
                        {isOpen ? "−" : "+"}
                      </button>
                    </div>

                    {isOpen && (
                      <ExpandedRow
                        kind={kind}
                        id={id}
                        members={
                          grouped?.childrenOf.get(
                            splitSource(row.name, row.source)
                              .name.trim()
                              .toLowerCase()
                              .replace(/\s+/g, " ")
                          ) ?? null
                        }
                      />
                    )}
                  </div>
                );
              })}

              {/* Never truncate silently: a table that stops at 300 with
                  no explanation reads as missing data. */}
              {matched.length > shown.length && (
                <p className="muted lookup-hint">
                  Showing {shown.length} of {matched.length}. Narrow the filters
                  to see the rest.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The opened row.
 *
 * Its own component so the fetch is scoped to it: closing the row
 * unmounts the hook and the subscription with it, rather than leaving
 * one query per row you have ever looked at.
 */
function ExpandedRow({
  kind,
  id,
  members,
}: {
  kind: LookupKind;
  id: string;
  /**
   * A parent's own children — subclasses, or species variants. Null
   * for the kinds that are flat.
   *
   * Named `members` rather than `children` on purpose: `children` is
   * React's own prop, and a component taking both would be reading two
   * different things out of one word.
   */
  members?: Record<string, unknown>[] | null;
}) {
  /* An inferred parent has no row to fetch — it exists because its
     children name it, not because the library holds it. Asking Convex
     for one sends a synthetic id to a validator expecting a real one,
     which is an ArgumentValidationError rather than an empty result.

     Computed ONCE and applied to every query below. It used to gate
     only the classes query, because classes were the only kind that
     had inferred parents at the time — so the day species grew them
     too, the species query fetched `absent:(vrgtr)` and the tab
     crashed. A per-kind guard is a guard somebody has to remember. */
  const real = !id.startsWith(ABSENT_PARENT_ID);
  const on = (want: LookupKind) => kind === want && real;

  const spell = useQuery(
    api.lookup.getSpell,
    on("spells") ? { id: id as Id<"spells"> } : "skip"
  );
  const item = useQuery(
    api.lookup.getItem,
    on("items") ? { id: id as Id<"items"> } : "skip"
  );
  const monster = useQuery(
    api.lookup.getMonster,
    on("monsters") ? { id: id as Id<"monsters"> } : "skip"
  );
  const feat = useQuery(
    api.lookup.getFeat,
    on("feats") ? { id: id as Id<"feats"> } : "skip"
  );
  const background = useQuery(
    api.lookup.getBackground,
    on("backgrounds") ? { id: id as Id<"backgrounds"> } : "skip"
  );
  const klass = useQuery(
    api.lookup.getClass,
    on("classes") ? { id: id as Id<"classes"> } : "skip"
  );
  const speciesRow = useQuery(
    api.lookup.getSpecies,
    on("species") ? { id: id as Id<"species"> } : "skip"
  );

  // Keyed, for the same reason the index is: a chain ending in a bare
  // fallback silently serves one kind's row under another kind's name.
  const row = {
    spells: spell,
    items: item,
    monsters: monster,
    feats: feat,
    backgrounds: background,
    classes: klass,
    species: speciesRow,
  }[kind] as Record<string, unknown> | null | undefined;

  if (!real) {
    return (
      <div className="lk-panel">
        <article className="lk lk-classes">
          <p className="lk-inferred">
            This library has no entry for the class itself — only the
            subclasses below, which name it. In a 5e campaign that is
            usually because the only write-up of the class is the 2024
            one, which a 5e game does not use.
          </p>
          {members && members.length > 0 && (
            <FamilyList kind={kind} members={members} />
          )}
        </article>
      </div>
    );
  }

  return (
    <div className="lk-panel">
      {row === undefined && <p className="muted lookup-hint">Loading…</p>}
      {row === null && (
        <p className="muted lookup-hint">That entry is no longer there.</p>
      )}
      {row && <LookupDetail kind={kind} row={row} members={members} />}
    </div>
  );
}

/**
 * Three layouts, because the three kinds are read differently.
 *
 * An item is a subtitle and prose. A spell is a grid of eight labelled
 * cells you scan without reading the labels, so a missing value keeps
 * its slot rather than collapsing the grid. A monster is a stat block —
 * rules between bands, ability scores in a row, traits and actions as
 * named blocks — with its description underneath rather than inside it,
 * because the block is reference and the description is story.
 */
function LookupDetail({
  kind,
  row,
  members,
}: {
  kind: LookupKind;
  row: Record<string, unknown>;
  members?: Record<string, unknown>[] | null;
}) {
  const body = readBlocks(row.blocks);
  const source = typeof row.source === "string" ? row.source : "";

  return (
    <article className={`lk lk-${kind}`}>
      {/* Two columns, top-aligned, and the picture's column is ITS OWN:
          nothing flows under it, not the stat block and not the prose.
          A description that ran full width beneath would put text under
          the image again, which is the thing being avoided. */}
      <div className="lk-columns">
        <div className="lk-main">
          <h2 className="lk-name">{String(row.name)}</h2>

          {kind === "items" && <ItemHead row={row} />}
          {kind === "spells" && <SpellHead row={row} />}
          {kind === "monsters" && <MonsterBlock row={row} />}
          {kind === "feats" && <FeatHead row={row} />}
          {kind === "backgrounds" && <BackgroundHead row={row} />}
          {kind === "classes" && <ClassHead row={row} />}
          {kind === "species" && <SpeciesHead row={row} />}

          {body.length > 0 && (
            <section className="lk-body">
              {/* On a monster this is a section of its own, under the
                  block: the stat block is reference, the description is
                  story. */}
              {kind === "monsters" && <h3 className="lk-h">Description</h3>}
              <Blocks blocks={body} />
            </section>
          )}
        </div>

        <BigArt row={row} />
      </div>

      {/* A class's subclasses, under everything that applies whichever
          one you take. Below the description rather than beside it:
          the general rules come first because you read them first. */}
      {members && members.length > 0 && (
        <FamilyList kind={kind} members={members} />
      )}

      {kind === "spells" && typeof row.materials === "string" && row.materials && (
        <p className="lk-footnote">* — ({row.materials})</p>
      )}

      {source && <p className="lk-source">{source}</p>}
    </article>
  );
}

/**
 * A class's subclasses, under everything that applies whichever one
 * you take. Below the description rather than beside it: the general
 * rules come first because you read them first.
 */
function FamilyList({
  kind,
  members,
}: {
  kind: LookupKind;
  members: Record<string, unknown>[];
}) {
  return (
    <section className="lk-subclasses">
      <h3 className="lk-h">
        {FAMILY_LABEL[kind] ?? "Variants"}{" "}
        <span className="lk-subclass-count">{members.length}</span>
      </h3>
      <div className="lk-subrows">
        {members.map((member) => (
          <FamilyRow
            key={String(member._id)}
            kind={kind}
            member={member}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One child, as a row that opens.
 *
 * The second level of the same gesture the table uses: a caret, a
 * name, and the entry underneath when you want it. It was a plain
 * list, which told you a Champion exists and then made you go and find
 * it — on a screen whose whole point is that a class and its options
 * are one thing you read together.
 *
 * Its own `open` state rather than the table's. Which children you
 * have unfolded belongs to the entry you are reading, and closing the
 * parent should not leave them remembered — the table's Set is keyed
 * by id and would.
 *
 * The body is the SAME ExpandedRow the table uses. A subclass is a row
 * in the classes table like any other, and a Wood Elf a row in the
 * species table; it is only the list it sits in that is different, so
 * nothing here re-implements how one is drawn.
 */
function FamilyRow({
  kind,
  member,
}: {
  kind: LookupKind;
  member: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const clean = splitSource(member.name, member.source);
  const id = String(member._id);

  return (
    <div className={`lk-subrow${open ? " open" : ""}`}>
      <button
        type="button"
        className="lk-subrow-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lk-subcaret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="lk-subclass-name">{clean.name}</span>
        {clean.source && (
          <span className="lk-subclass-src">{clean.source}</span>
        )}
      </button>

      {/* Outside the head button, not inside it — a button holding the
          entry would nest the artwork's own button and the whole thing
          would fail hydration. */}
      {open && <ExpandedRow kind={kind} id={id} />}
    </div>
  );
}

/**
 * A row's artwork.
 *
 * The path is mirror-relative ("web/foundry/icons/..."), the same
 * convention NPC portraits and location maps use — see
 * scripts/fetch-foundry-images.mjs for getting the files there, and
 * artSrc for which base they hang off. Either the map server serves the
 * mirror or the app serves it out of public/; the stored path is the
 * same for both, so which one is in use is an environment variable
 * rather than a re-import.
 */
function Art({ row, className }: { row: Record<string, unknown>; className: string }) {
  const src = artSrc(row.image, process.env.NEXT_PUBLIC_MAP_SERVER);
  const [broken, setBroken] = useState(false);
  if (!src) return null;

  /* A row whose file will not load keeps its square, empty and dashed.
     It used to hide the <img> outright, which made "this row has no
     art" and "the artwork mirror is not there" the same picture of
     nothing — so a mirror that had gone missing looked exactly like a
     library that never had pictures, on every row at once, with
     nothing anywhere saying otherwise. The title says which it is. */
  if (broken) {
    return (
      <span
        className={`${className} lk-art-missing`}
        title={`No file at ${src} — the artwork mirror is missing or out of date. Run: npm run art-check`}
      />
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/**
 * The panel's artwork: big, beside the stat block, and enlargeable.
 *
 * Clicking it opens the full-size file. Monster art is often much
 * larger than the column it sits in, and the column is sized for the
 * stat block rather than for the picture — so the small copy is a
 * thumbnail of something worth actually looking at.
 */
function BigArt({ row }: { row: Record<string, unknown> }) {
  const src = artSrc(row.image, process.env.NEXT_PUBLIC_MAP_SERVER);
  const [zoomed, setZoomed] = useState(false);
  const [broken, setBroken] = useState(false);

  // Escape closes it, which is what every full-screen thing in a browser
  // has taught people to expect.
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (!src) return null;
  const name = typeof row.name === "string" ? row.name : "";

  /* Same as the row thumbnail: the panel says the art is missing
     rather than quietly closing the gap where it was. This is the one
     place with room to say why in words. */
  if (broken) {
    return (
      <p className="lk-art-gone">
        The artwork for this entry is not in the mirror.
        <br />
        <code>{src}</code>
      </p>
    );
  }

  return (
    <>
      <button
        type="button"
        className="lk-art-frame"
        title={`${name} — click to enlarge`}
        onClick={(e) => {
          // The row header toggles open/closed on click; this sits inside
          // the panel it opened, and must not close it again.
          e.stopPropagation();
          setZoomed(true);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="lk-art-big"
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      </button>

      {zoomed && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={name}
          onClick={(e) => {
            e.stopPropagation();
            setZoomed(false);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={name} />
          <p className="lightbox-hint">Click anywhere, or press Esc, to close</p>
        </div>
      )}
    </>
  );
}

/** "Wondrous Item, very rare (requires attunement)", then cost/weight. */
/**
 * The four build kinds all read the same way: a subtitle saying what
 * this IS, then a short list of the facts, then the entry's own prose.
 *
 * They share one renderer rather than four, because they genuinely
 * have the same shape — unlike a spell and a stat block, which do not.
 * `buildSubtitle` and `buildFacts` are declarations in lookupFields.ts,
 * so what each kind says is data and this is only how it is drawn.
 */
function BuildHead({
  kind,
  row,
}: {
  kind: LookupKind;
  row: Record<string, unknown>;
}) {
  const subtitle = buildSubtitle(kind, row);
  const facts = buildFacts(kind, row);

  return (
    <>
      {subtitle && <p className="lk-sub">{subtitle}</p>}
      <div className="lk-rule" />
      {facts.length > 0 && (
        <dl className="lk-facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

const FeatHead = ({ row }: { row: Record<string, unknown> }) => (
  <BuildHead kind="feats" row={row} />
);
const BackgroundHead = ({ row }: { row: Record<string, unknown> }) => (
  <BuildHead kind="backgrounds" row={row} />
);
const ClassHead = ({ row }: { row: Record<string, unknown> }) => (
  <BuildHead kind="classes" row={row} />
);
const SpeciesHead = ({ row }: { row: Record<string, unknown> }) => (
  <BuildHead kind="species" row={row} />
);

function ItemHead({ row }: { row: Record<string, unknown> }) {
  const facts = itemFacts(row);
  return (
    <>
      <p className="lk-sub">{itemSubtitle(row)}</p>
      <div className="lk-rule" />
      {facts.length > 0 && (
        <dl className="lk-facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** The eight-cell grid above a spell's text. */
function SpellHead({ row }: { row: Record<string, unknown> }) {
  const cells = spellCells(row);
  const flags = [
    row.ritual === true ? "Ritual" : null,
    row.concentration === true ? "Concentration" : null,
  ].filter(Boolean);

  return (
    <>
      <div className="lk-rule accent" />
      <dl className="lk-grid">
        {cells.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd>{c.value}</dd>
          </div>
        ))}
      </dl>
      {flags.length > 0 && (
        <div className="lk-tags">
          {flags.map((f) => (
            <span key={f} className="lk-tag">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="lk-rule accent" />
    </>
  );
}

/** The stat block: bands separated by rules, in the printed order. */
function MonsterBlock({ row }: { row: Record<string, unknown> }) {
  const subtitle = monsterSubtitle(row);
  const abilities = abilityCells(row.abilities);
  const lines = monsterTraitLines(row);
  const traits = features(row.traits);
  const actions = features(row.actions);
  const legendary = features(row.legendaryActions);

  const defence = [
    typeof row.ac === "number" ? { label: "Armor Class", value: row.ac } : null,
    typeof row.hp === "number" ? { label: "Hit Points", value: row.hp } : null,
    typeof row.speed === "string" && row.speed
      ? { label: "Speed", value: row.speed }
      : null,
  ].filter(Boolean) as { label: string; value: string | number }[];

  return (
    <div className="lk-block">
      {subtitle && <p className="lk-sub">{subtitle}</p>}

      {defence.length > 0 && (
        <>
          <div className="lk-rule" />
          <ul className="lk-lines">
            {defence.map((d) => (
              <li key={d.label}>
                <span className="lk-key">{d.label}</span> {d.value}
              </li>
            ))}
          </ul>
        </>
      )}

      {abilities.length > 0 && (
        <>
          <div className="lk-rule" />
          <div className="lk-abilities">
            {abilities.map((a) => (
              <div key={a.key}>
                <div className="lk-ab-label">{a.label}</div>
                <div className="lk-ab-score">
                  {a.score} <span className="lk-ab-mod">({a.modifier})</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {lines.length > 0 && (
        <>
          <div className="lk-rule" />
          <ul className="lk-lines">
            {lines.map((l) => (
              <li key={l.label}>
                <span className="lk-key">{l.label}</span> {l.value}
              </li>
            ))}
          </ul>
        </>
      )}

      <FeatureList title="Traits" items={traits} />
      <FeatureList title="Actions" items={actions} />
      <FeatureList title="Legendary Actions" items={legendary} />
    </div>
  );
}

function FeatureList({ title, items }: { title: string; items: Feature[] }) {
  if (items.length === 0) return null;
  return (
    <section className="lk-features">
      <h3 className="lk-h">{title}</h3>
      {items.map((f) => (
        <div key={f.name} className="lk-feature">
          {/* The name runs into the first paragraph the way a stat
              block prints it, so the lead block is inlined and the
              rest — a table, a numbered list — follows underneath. */}
          <p className="lk-feature-lead">
            <span className="lk-feature-name">{f.name}.</span>{" "}
            {f.blocks[0]?.type === "text" ? f.blocks[0].text : ""}
          </p>
          <Blocks
            blocks={f.blocks[0]?.type === "text" ? f.blocks.slice(1) : f.blocks}
          />
        </div>
      ))}
    </section>
  );
}

/**
 * Text, tables and lists, in the order the source had them.
 *
 * Nothing here is markup: the importer turned the HTML into data, so a
 * table is rendered as real elements rather than injected.
 */
function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") {
          return b.text
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, j) => <p key={`${i}-${j}`}>{p}</p>);
        }

        if (b.type === "list") {
          const List = b.ordered ? "ol" : "ul";
          return (
            <List key={i} className="lk-list">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </List>
          );
        }

        return (
          <div key={i} className="lk-table-wrap">
            <table className="lk-datatable">
              {b.headers.length > 0 && (
                <thead>
                  <tr>
                    {b.headers.map((h, j) => (
                      <th key={j}>{h}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
