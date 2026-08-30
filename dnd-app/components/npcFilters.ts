import { FieldKind } from "@/components/npcColumns";

/**
 * Filter conditions, in the shape Airtable trained everyone to expect:
 * `Where <field> <operator> <value>`, stacked, joined by And or Or.
 *
 * The operator list is driven by the field's kind, because "has any of"
 * is meaningless on a number and "is empty" needs no value at all. Every
 * kind gets the empty/not-empty pair — the most useful filter on this
 * roster is "Picture is empty", i.e. who still needs a portrait.
 *
 * Evaluation happens in the browser against the single subscription, so
 * a condition costs nothing per keystroke. The one rule that is NOT
 * enforced here: GM-only fields are filtered out of the offered field
 * list, but that is a courtesy — the server already sends players null
 * for them, so a hand-crafted condition on `secret` matches nothing
 * rather than revealing anything.
 */

export type FilterCondition = {
  field: string;
  operator: string;
  values: string[];
};

export type Conjunction = "and" | "or";

/** How many value inputs an operator needs. */
export type Arity = "none" | "one" | "many";

export type OperatorDef = {
  id: string;
  label: string;
  arity: Arity;
  kinds: FieldKind[];
};

const TEXTUAL: FieldKind[] = ["text", "longtext"];
const ALL_KINDS: FieldKind[] = [
  "text",
  "longtext",
  "number",
  "chips",
  "boolean",
  "picture",
];

export const OPERATORS: OperatorDef[] = [
  // Multi-value fields
  { id: "hasAnyOf", label: "has any of…", arity: "many", kinds: ["chips"] },
  { id: "hasAllOf", label: "has all of…", arity: "many", kinds: ["chips"] },
  { id: "isExactly", label: "is exactly…", arity: "many", kinds: ["chips"] },
  { id: "hasNoneOf", label: "has none of…", arity: "many", kinds: ["chips"] },

  // Text
  { id: "is", label: "is…", arity: "one", kinds: TEXTUAL },
  { id: "isNot", label: "is not…", arity: "one", kinds: TEXTUAL },
  {
    id: "contains",
    label: "contains…",
    arity: "one",
    kinds: [...TEXTUAL, "chips"],
  },
  {
    id: "doesNotContain",
    label: "does not contain…",
    arity: "one",
    kinds: [...TEXTUAL, "chips"],
  },

  // Numbers
  { id: "eq", label: "=", arity: "one", kinds: ["number"] },
  { id: "neq", label: "≠", arity: "one", kinds: ["number"] },
  { id: "gt", label: ">", arity: "one", kinds: ["number"] },
  { id: "gte", label: "≥", arity: "one", kinds: ["number"] },
  { id: "lt", label: "<", arity: "one", kinds: ["number"] },
  { id: "lte", label: "≤", arity: "one", kinds: ["number"] },

  // Booleans
  { id: "isChecked", label: "is checked", arity: "none", kinds: ["boolean"] },
  {
    id: "isNotChecked",
    label: "is not checked",
    arity: "none",
    kinds: ["boolean"],
  },

  // Attachments
  {
    id: "filenameContains",
    label: "filename contains…",
    arity: "one",
    kinds: ["picture"],
  },

  // Everything
  { id: "isEmpty", label: "is empty", arity: "none", kinds: ALL_KINDS },
  { id: "isNotEmpty", label: "is not empty", arity: "none", kinds: ALL_KINDS },
];

export function operatorsFor(kind: FieldKind): OperatorDef[] {
  return OPERATORS.filter((op) => op.kinds.includes(kind));
}

export function operatorById(id: string): OperatorDef | undefined {
  return OPERATORS.find((op) => op.id === id);
}

/** The operator a freshly-added condition starts on. */
export function defaultOperatorFor(kind: FieldKind): string {
  switch (kind) {
    case "chips":
      return "hasAnyOf";
    case "number":
      return "eq";
    case "boolean":
      return "isChecked";
    case "picture":
      return "isEmpty";
    default:
      return "is";
  }
}

function isBlank(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (Array.isArray(raw)) return raw.filter((v) => v !== "" && v != null).length === 0;
  if (typeof raw === "string") return raw.trim() === "";
  return false;
}

function asStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return (raw as string[]).filter(Boolean);
  if (raw === null || raw === undefined || raw === "") return [];
  return [String(raw)];
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Does one row satisfy one condition?
 *
 * Unknown operators return true rather than false: a saved layout naming
 * an operator this build doesn't have should show everything, not hide
 * the whole roster with no explanation.
 */
export function matchesCondition(
  raw: unknown,
  condition: FilterCondition
): boolean {
  const { operator, values } = condition;
  const blank = isBlank(raw);

  switch (operator) {
    case "isEmpty":
      return blank;
    case "isNotEmpty":
      return !blank;
  }

  // Every remaining operator is a positive test, so a blank value can
  // only satisfy the negative ones.
  const vals = asStrings(raw);
  const lowered = vals.map(lower);
  const wanted = values.map(lower).filter(Boolean);
  const first = wanted[0] ?? "";

  switch (operator) {
    case "hasAnyOf":
      return wanted.length === 0 || wanted.some((w) => lowered.includes(w));
    case "hasAllOf":
      return wanted.every((w) => lowered.includes(w));
    case "hasNoneOf":
      return !wanted.some((w) => lowered.includes(w));
    case "isExactly":
      return (
        wanted.length === lowered.length &&
        wanted.every((w) => lowered.includes(w))
      );

    case "is":
      return !first || lowered.some((v) => v === first);
    case "isNot":
      return !first || !lowered.some((v) => v === first);
    case "contains":
      return !first || lowered.some((v) => v.includes(first));
    case "doesNotContain":
      return !first || !lowered.some((v) => v.includes(first));
    case "filenameContains":
      return !first || lowered.some((v) => v.includes(first));

    case "isChecked":
      return raw === true;
    case "isNotChecked":
      return raw !== true;

    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (!first) return true;
      const target = Number(first);
      if (!Number.isFinite(target)) return true;
      if (typeof raw !== "number") return false;
      if (operator === "eq") return raw === target;
      if (operator === "neq") return raw !== target;
      if (operator === "gt") return raw > target;
      if (operator === "gte") return raw >= target;
      if (operator === "lt") return raw < target;
      return raw <= target;
    }

    default:
      return true;
  }
}

/** Combine every condition against one row. */
export function matchesAll(
  getValue: (field: string) => unknown,
  conditions: FilterCondition[],
  conjunction: Conjunction
): boolean {
  if (conditions.length === 0) return true;
  const results = conditions.map((c) => matchesCondition(getValue(c.field), c));
  return conjunction === "or" ? results.some(Boolean) : results.every(Boolean);
}
