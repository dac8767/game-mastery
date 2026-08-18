"use client";

import { useState } from "react";
import { ColumnDef } from "@/components/npcColumns";
import {
  Conjunction,
  FilterCondition,
  defaultOperatorFor,
  operatorById,
  operatorsFor,
} from "@/components/npcFilters";

/**
 * The condition builder: `Where <field> <operator> <value>`, stacked.
 *
 * Operators come from the field's kind, so a number offers ≥ and a
 * multi-select offers "has any of". Every field offers "is empty" /
 * "is not empty", which is what makes "Picture is empty" — show me
 * everyone who still needs a portrait — a one-click question.
 *
 * Value inputs adapt to the operator's arity: none, one, or a token
 * list. Known values are offered as options so you rarely have to type,
 * but free text is always allowed since the roster keeps growing.
 */
export function FilterPanel({
  conditions,
  conjunction,
  fields,
  valueOptions,
  onChange,
  onConjunctionChange,
}: {
  conditions: FilterCondition[];
  conjunction: Conjunction;
  fields: ColumnDef[];
  valueOptions: Map<string, string[]>;
  onChange: (next: FilterCondition[]) => void;
  onConjunctionChange: (next: Conjunction) => void;
}) {
  const update = (i: number, patch: Partial<FilterCondition>) => {
    onChange(conditions.map((c, j) => (i === j ? { ...c, ...patch } : c)));
  };

  const addCondition = () => {
    const field = fields[0];
    if (!field) return;
    onChange([
      ...conditions,
      {
        field: field.key,
        operator: defaultOperatorFor(field.kind),
        values: [],
      },
    ]);
  };

  return (
    <div className="filter-panel">
      <div className="filter-title">Filter</div>

      {conditions.length === 0 && (
        <p className="settings-note">
          No conditions. Everything shows.
        </p>
      )}

      {conditions.map((condition, i) => {
        const def =
          fields.find((f) => f.key === condition.field) ?? fields[0];
        const ops = operatorsFor(def.kind);
        const op =
          operatorById(condition.operator) ??
          operatorById(defaultOperatorFor(def.kind))!;
        const options = valueOptions.get(condition.field) ?? [];

        return (
          <div className="filter-row" key={i}>
            {i === 0 ? (
              <span className="filter-lead">Where</span>
            ) : (
              <select
                className="filter-lead as-select"
                value={conjunction}
                onChange={(e) =>
                  onConjunctionChange(e.target.value as Conjunction)
                }
                disabled={i > 1}
                title={
                  i > 1
                    ? "One conjunction applies to the whole group"
                    : undefined
                }
              >
                <option value="and">and</option>
                <option value="or">or</option>
              </select>
            )}

            <select
              className="filter-field"
              value={condition.field}
              onChange={(e) => {
                const next = fields.find((f) => f.key === e.target.value);
                if (!next) return;
                // Operators don't survive a kind change, so reset both.
                update(i, {
                  field: next.key,
                  operator: defaultOperatorFor(next.kind),
                  values: [],
                });
              }}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>

            <select
              className="filter-op"
              value={op.id}
              onChange={(e) => update(i, { operator: e.target.value })}
            >
              {ops.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>

            <ValueInput
              arity={op.arity}
              kind={def.kind}
              values={condition.values}
              options={options}
              onChange={(values) => update(i, { values })}
            />

            <button
              type="button"
              className="filter-remove"
              title="Remove condition"
              onClick={() => onChange(conditions.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="filter-actions">
        <button type="button" className="text-button" onClick={addCondition}>
          + Add condition
        </button>
        {conditions.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => onChange([])}
          >
            Remove all
          </button>
        )}
      </div>
    </div>
  );
}

function ValueInput({
  arity,
  kind,
  values,
  options,
  onChange,
}: {
  arity: "none" | "one" | "many";
  kind: string;
  values: string[];
  options: string[];
  onChange: (values: string[]) => void;
}) {
  const [typed, setTyped] = useState("");

  if (arity === "none") {
    return <span className="filter-value none" />;
  }

  if (arity === "one") {
    return (
      <span className="filter-value">
        <input
          list={options.length ? `opts-${kind}-${options.length}` : undefined}
          type={kind === "number" ? "number" : "text"}
          placeholder="Enter a value"
          value={values[0] ?? ""}
          onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        />
        {options.length > 0 && (
          <datalist id={`opts-${kind}-${options.length}`}>
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
      </span>
    );
  }

  const remaining = options.filter((o) => !values.includes(o));

  return (
    <span className="filter-value many">
      {values.map((v) => (
        <span className="chip" key={v}>
          {v}
          <button
            type="button"
            className="chip-x"
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            ✕
          </button>
        </span>
      ))}

      {remaining.length > 0 ? (
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            onChange([...values, e.target.value]);
          }}
        >
          <option value="">Add…</option>
          {remaining.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          placeholder="Add value"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !typed.trim()) return;
            e.preventDefault();
            onChange([...values, typed.trim()]);
            setTyped("");
          }}
        />
      )}
    </span>
  );
}
