/**
 * The campaign's layout for an opened NPC.
 *
 * npcSections.ts is the arrangement the app ships with. This is the one
 * the DM builds instead: their own tabs, their own choice of fields,
 * their own order and widths, applied to every NPC in the campaign so
 * the record reads the same way every time you open one.
 *
 * The template stores only what the DM decided. It is never the
 * authority on what a field IS — that is npcColumns.ts — and it is
 * never the authority on who may see one, which is the server's. A
 * template naming `dmNotes` does not show `dmNotes` to a player: the
 * row simply does not contain it, and the tab renders without it.
 *
 * Free of React, Convex, and sibling imports so the unit guard can
 * compile it alone. Where it needs to know the app's own arrangement —
 * building a starting template — the sections are passed IN rather than
 * imported, which keeps this module honest about having no opinion of
 * its own on where `region` belongs.
 */

/** How many of the grid's columns one field spans. */
export const SPANS = [
  { value: 1, label: "Narrow" },
  { value: 2, label: "Medium" },
  { value: 3, label: "Wide" },
  { value: 4, label: "Full width" },
];

export const MIN_SPAN = 1;
export const MAX_SPAN = 4;

/**
 * How many grid ROWS a field takes.
 *
 * Separate from the column span because they answer different
 * questions: how wide is about fitting a value on one line, how tall
 * is about a description getting room to breathe. A two-row field
 * beside two one-row fields is the arrangement that needs both, and it
 * is only possible if the rows are a fixed track — which is why the
 * record grid sets grid-auto-rows rather than letting content decide.
 */
export const MIN_ROWS = 1;
export const MAX_ROWS = 6;

export const ROW_SPANS = [
  { value: 1, label: "1 row" },
  { value: 2, label: "2 rows" },
  { value: 3, label: "3 rows" },
  { value: 4, label: "4 rows" },
];

/** Bounds, so a typo cannot produce a template nothing can render. */
export const TEMPLATE_LIMITS = {
  tabs: 12,
  titleLength: 40,
};

export interface TemplateField {
  key: string;
  /** 1-4 columns of the record grid. */
  span: number;
  /** 1-6 rows of the record grid. */
  rows: number;
  /**
   * Off the record, but still in the template.
   *
   * NOT the same as removing it. A field the template does not mention
   * is one reconcileTemplate puts straight back under "More" on the
   * next load, so removal cannot hide anything — and it would leave the
   * field with no row in the editor, which is a field you cannot bring
   * back. Hidden keeps its place, its size and its tab.
   */
  hidden?: boolean;
}

export interface TemplateTab {
  id: string;
  title: string;
  fields: TemplateField[];
}

export interface NpcTemplate {
  tabs: TemplateTab[];
}

/**
 * A template as it comes off the wire, before reconciling.
 *
 * Every part optional because every part might be: a document stored
 * before a field existed, or one hand-edited in the dashboard. This is
 * the shape `reconcileTemplate` accepts; NpcTemplate is what it
 * returns.
 */
export interface LooseTemplate {
  tabs?: {
    id?: string;
    title?: string;
    fields?: {
      key?: string;
      span?: number;
      rows?: number;
      hidden?: boolean;
    }[];
  }[];
}

const clampSpan = (n: unknown): number => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, v));
};

const clampRows = (n: unknown): number => {
  const v = Math.round(Number(n));
  // Absent is the common case, not an error: every field stored before
  // rows existed has none, and one row is what it was being given.
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, v));
};

/**
 * A stable id from a title, plus an index so two tabs called the same
 * thing do not collide.
 *
 * Ids rather than titles as the handle, because renaming a tab must not
 * move the fields out of it.
 */
export function tabId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "tab"}-${index}`;
}

/**
 * The app's own arrangement, as an editable template.
 *
 * The starting point for a DM who opens the designer: what they were
 * already looking at, rather than an empty page they have to rebuild
 * before the record works again.
 */
export function defaultTemplate(
  sections: { id: string; title: string; keys: string[] }[],
  wideKeys: string[] = []
): NpcTemplate {
  const wide = new Set(wideKeys);
  return {
    tabs: sections.map((s, i) => ({
      id: s.id || tabId(s.title, i),
      title: s.title,
      fields: s.keys.map((key) => ({
        key,
        span: wide.has(key) ? 4 : 1,
        rows: wide.has(key) ? 2 : 1,
      })),
    })),
  };
}

/**
 * A template made safe to render against the columns that exist. IDEMPOTENT.
 *
 * Runs on every read and every save, because a template can outlive the
 * field list it was built from: a column renamed in npcColumns.ts leaves
 * a field pointing at nothing, and a column ADDED leaves the template
 * with no opinion about it at all.
 *
 * The second case is the one that matters. A new field the template does
 * not mention would be invisible in every record in the campaign — not
 * missing from a tab, missing from the app — and the DM would have no
 * way to notice, because the designer is built from the template too. So
 * unplaced keys are appended to the last tab. Visible in the wrong place
 * beats gone.
 */
export function reconcileTemplate(
  // Deliberately loose. What arrives is a stored document, which may
  // predate any field this type currently requires — `rows` did not
  // exist last week — and the whole job of this function is to turn
  // whatever is there into something renderable. Typing the input as a
  // complete NpcTemplate would be claiming the guarantee it provides.
  template: LooseTemplate | null | undefined,
  validKeys: string[]
): NpcTemplate {
  const valid = new Set(validKeys);
  const seen = new Set<string>();
  const tabs: TemplateTab[] = [];

  for (const [i, tab] of (template?.tabs ?? []).entries()) {
    const fields: TemplateField[] = [];
    for (const f of tab?.fields ?? []) {
      const key = String(f?.key ?? "");
      // A key twice over renders twice, and the second control writes
      // to a field the eye has already scrolled past.
      if (!valid.has(key) || seen.has(key)) continue;
      seen.add(key);
      // `hidden` carried through reconciliation, or a hidden field
      // would come back visible on the next load — which reads as the
      // hide having silently not saved.
      fields.push({
        key,
        span: clampSpan(f?.span),
        rows: clampRows(f?.rows),
        ...(f?.hidden ? { hidden: true } : {}),
      });
    }
    const title = String(tab?.title ?? "").trim().slice(0, TEMPLATE_LIMITS.titleLength);
    tabs.push({
      id: String(tab?.id ?? "") || tabId(title, i),
      title: title || `Tab ${i + 1}`,
      fields,
    });
    if (tabs.length >= TEMPLATE_LIMITS.tabs) break;
  }

  // Ids must be unique or the tab strip cannot say which tab is open.
  const usedIds = new Set<string>();
  for (const [i, tab] of tabs.entries()) {
    let id = tab.id;
    let n = i;
    while (usedIds.has(id)) id = tabId(tab.title, ++n);
    usedIds.add(id);
    tab.id = id;
  }

  if (tabs.length === 0) {
    tabs.push({ id: "fields-0", title: "Fields", fields: [] });
  }

  const missing = validKeys.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    tabs[tabs.length - 1].fields.push(
      ...missing.map((key) => ({ key, span: 1, rows: 1 }))
    );
  }

  return { tabs };
}

/** Every key the template places, in render order. */
export function templateKeys(template: NpcTemplate): string[] {
  return template.tabs.flatMap((t) => t.fields.map((f) => f.key));
}

/**
 * The template as this viewer sees it: only the fields they were sent.
 *
 * Tabs left with nothing in them are dropped. A player looking at a
 * campaign whose DM made a "Secrets" tab should not find the tab there,
 * empty — the outline of what was withheld is still information.
 */
export function templateFor(
  template: NpcTemplate,
  allowed: string[]
): TemplateTab[] {
  const permitted = new Set(allowed);
  return template.tabs
    .map((t) => ({
      ...t,
      fields: t.fields.filter((f) => permitted.has(f.key)),
    }))
    .filter((t) => t.fields.length > 0);
}

/** Move a field to a tab, at a position. Removing it from wherever it was. */
export function moveField(
  template: NpcTemplate,
  key: string,
  toTabId: string,
  toIndex: number
): NpcTemplate {
  const moved =
    template.tabs
      .flatMap((t) => t.fields)
      .find((f) => f.key === key) ?? { key, span: 1, rows: 1 };

  return {
    tabs: template.tabs.map((t) => {
      const without = t.fields.filter((f) => f.key !== key);
      if (t.id !== toTabId) return { ...t, fields: without };
      const at = Math.min(Math.max(0, Math.round(toIndex)), without.length);
      return {
        ...t,
        fields: [...without.slice(0, at), moved, ...without.slice(at)],
      };
    }),
  };
}

/** Nudge a field up or down within its own tab. */
export function shiftField(
  template: NpcTemplate,
  key: string,
  delta: number
): NpcTemplate {
  return {
    tabs: template.tabs.map((t) => {
      const at = t.fields.findIndex((f) => f.key === key);
      if (at === -1) return t;
      const to = at + Math.round(delta);
      if (to < 0 || to >= t.fields.length) return t;
      const fields = t.fields.slice();
      const [f] = fields.splice(at, 1);
      fields.splice(to, 0, f);
      return { ...t, fields };
    }),
  };
}

export function setSpan(
  template: NpcTemplate,
  key: string,
  span: number
): NpcTemplate {
  return {
    tabs: template.tabs.map((t) => ({
      ...t,
      fields: t.fields.map((f) =>
        f.key === key ? { ...f, span: clampSpan(span) } : f
      ),
    })),
  };
}

export function setRows(
  template: NpcTemplate,
  key: string,
  rows: number
): NpcTemplate {
  return {
    tabs: template.tabs.map((t) => ({
      ...t,
      fields: t.fields.map((f) =>
        f.key === key ? { ...f, rows: clampRows(rows) } : f
      ),
    })),
  };
}

export function addTab(template: NpcTemplate, title: string): NpcTemplate {
  if (template.tabs.length >= TEMPLATE_LIMITS.tabs) return template;
  const clean =
    title.trim().slice(0, TEMPLATE_LIMITS.titleLength) ||
    `Tab ${template.tabs.length + 1}`;
  const used = new Set(template.tabs.map((t) => t.id));
  let id = tabId(clean, template.tabs.length);
  let n = template.tabs.length;
  while (used.has(id)) id = tabId(clean, ++n);
  return { tabs: [...template.tabs, { id, title: clean, fields: [] }] };
}

export function renameTab(
  template: NpcTemplate,
  id: string,
  title: string
): NpcTemplate {
  return {
    tabs: template.tabs.map((t) =>
      t.id === id
        ? {
            ...t,
            title:
              title.trim().slice(0, TEMPLATE_LIMITS.titleLength) || t.title,
          }
        : t
    ),
  };
}

/**
 * Remove a tab, keeping its fields.
 *
 * They go to the tab before it rather than away with it: deleting a tab
 * is a statement about the tab, and losing six fields you spent an
 * evening arranging is not what anyone meant by it. The last tab cannot
 * be removed, because a template with no tabs has nowhere to render.
 */
export function removeTab(template: NpcTemplate, id: string): NpcTemplate {
  if (template.tabs.length <= 1) return template;
  const at = template.tabs.findIndex((t) => t.id === id);
  if (at === -1) return template;

  const orphans = template.tabs[at].fields;
  const into = at === 0 ? 1 : at - 1;
  return {
    tabs: template.tabs
      .map((t, i) =>
        i === into ? { ...t, fields: [...t.fields, ...orphans] } : t
      )
      .filter((_, i) => i !== at),
  };
}

/** Move a whole tab left or right in the strip. */
export function shiftTab(
  template: NpcTemplate,
  id: string,
  delta: number
): NpcTemplate {
  const at = template.tabs.findIndex((t) => t.id === id);
  if (at === -1) return template;
  const to = at + Math.round(delta);
  if (to < 0 || to >= template.tabs.length) return template;
  const tabs = template.tabs.slice();
  const [t] = tabs.splice(at, 1);
  tabs.splice(to, 0, t);
  return { tabs };
}

/**
 * Hide a field, or bring it back.
 *
 * A no-op for a key the template does not hold, like every other
 * operation here: an id that is not in the layout is an id that came
 * from a stale screen, and rebuilding the layout around it would be
 * worse than ignoring it.
 */
export function setFieldHidden(
  template: NpcTemplate,
  key: string,
  hidden: boolean
): NpcTemplate {
  return {
    tabs: template.tabs.map((tab) => ({
      ...tab,
      fields: tab.fields.map((f) =>
        f.key === key ? { ...f, hidden: hidden || undefined } : f
      ),
    })),
  };
}

/** Every key the layout is currently keeping off the record. */
export function hiddenKeys(template: NpcTemplate): string[] {
  return template.tabs.flatMap((tab) =>
    tab.fields.filter((f) => f.hidden).map((f) => f.key)
  );
}
