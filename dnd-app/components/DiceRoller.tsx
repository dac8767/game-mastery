"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  STANDARD_DICE,
  critOfDice,
  formatNotation,
  parseRoll,
} from "@/components/diceModel";

/**
 * The dice roller.
 *
 * The dice are thrown on the SERVER — nothing here decides a number.
 * What this file does is take the notation, show what it will roll
 * before it is rolled, and read the log back.
 *
 * The parse happens twice on purpose. Here it decides whether the Roll
 * button is available and what the preview says; in convex/dice.ts it
 * decides what is real. A client parse that disagreed with the server's
 * would show a disabled button on a roll that works, which is a nuisance
 * — the reverse, a client that decided its own result, would be a
 * cheat, and is why the server does not accept one.
 *
 * A secret roll is the DM's. It never appears in a player's data at all,
 * so there is nothing here that hides one: what arrives is already what
 * the caller is allowed to see.
 */

/** The most-used d20 rolls, which nobody should have to type. */
const SHORTCUTS: { label: string; notation: string; hint: string }[] = [
  { label: "Advantage", notation: "2d20kh1", hint: "Roll two d20, keep the higher" },
  { label: "Disadvantage", notation: "2d20kl1", hint: "Roll two d20, keep the lower" },
  { label: "Stats", notation: "4d6kh3", hint: "Four d6, drop the lowest" },
];

export function DiceRoller({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const view = useQuery(api.dice.listRolls, { campaignId });
  const rollDice = useMutation(api.dice.rollDice);
  const clearRolls = useMutation(api.dice.clearRolls);

  const [notation, setNotation] = useState("1d20");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isDm = view?.isDm ?? false;

  // What the box currently means, if it means anything. Recomputed per
  // keystroke, which is free — this is a dozen characters of arithmetic.
  const parsed = useMemo(() => parseRoll(notation), [notation]);

  async function throwDice(what: string, itsLabel?: string) {
    if (busy) return;
    setBusy(true);
    try {
      setError(null);
      await rollDice({
        campaignId,
        notation: what,
        label: (itsLabel ?? label).trim() || undefined,
        // The server ANDs this with DM status. Sending it from a
        // player's browser achieves nothing, which is the point.
        secret: secret || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That roll didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (view === undefined) {
    return <p className="centered-note">Fetching the dice…</p>;
  }

  return (
    <div className="dice">
      <section className="dice-controls">
        {/* One click, one die. The common case is not a formula. */}
        <div className="facet-label">Quick roll</div>
        <div className="dice-quick">
          {STANDARD_DICE.map((sides) => (
            <button
              key={sides}
              type="button"
              className="dice-die"
              disabled={busy}
              title={`Roll a d${sides}`}
              onClick={() => void throwDice(`1d${sides}`)}
            >
              d{sides}
            </button>
          ))}
        </div>

        <div className="facet-label">Common rolls</div>
        <div className="dice-shortcuts">
          {SHORTCUTS.map((s) => (
            <button
              key={s.notation}
              type="button"
              className="npc-btn"
              disabled={busy}
              title={s.hint}
              onClick={() => void throwDice(s.notation)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <form
          className="dice-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed) void throwDice(parsed.notation);
          }}
        >
          <div className="facet-label">Anything else</div>
          <input
            className="dice-notation"
            value={notation}
            onChange={(e) => setNotation(e.target.value)}
            placeholder="2d6+3"
            maxLength={60}
            spellCheck={false}
            aria-label="Dice notation"
          />
          <input
            className="dice-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What for? (optional)"
            maxLength={60}
            aria-label="Roll label"
          />

          {/* Says what the notation means BEFORE it is rolled, so a
              typo is caught by reading rather than by a strange total. */}
          <p className={`dice-preview${parsed ? "" : " bad"}`}>
            {parsed
              ? `Rolls ${formatNotation(parsed.terms)}`
              : notation.trim() === ""
                ? "Type something like 2d6+3, 4d6kh3, or d20."
                : `Can't read that. Try 2d6+3, 4d6kh3, or d20.`}
          </p>

          <div className="dice-go">
            <button
              type="submit"
              className="npc-btn primary"
              disabled={!parsed || busy}
            >
              Roll
            </button>
            {isDm && (
              <label className="dice-secret" title="Only you will see it">
                <input
                  type="checkbox"
                  checked={secret}
                  onChange={(e) => setSecret(e.target.checked)}
                />
                Roll in secret
              </label>
            )}
          </div>
        </form>

        {error && <p className="form-error nb-error">{error}</p>}
      </section>

      <section className="dice-log">
        <header className="dice-log-head">
          <span className="dice-log-title">Rolls</span>
          {isDm && view.rolls.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                if (window.confirm("Clear the table's roll log?")) {
                  void clearRolls({ campaignId }).catch((e: unknown) =>
                    setError(
                      e instanceof Error ? e.message : "Couldn't clear that."
                    )
                  );
                }
              }}
            >
              Clear
            </button>
          )}
        </header>

        {view.rolls.length === 0 && (
          <p className="centered-note">No rolls yet. Throw something.</p>
        )}

        {view.rolls.map((r) => {
          const crit = critOfDice(r.dice);
          return (
            <article
              key={r._id}
              className={`dice-roll${r.mine ? " mine" : ""}${
                r.secret ? " secret" : ""
              }${crit ? ` crit-${crit}` : ""}`}
            >
              <div className="dice-roll-head">
                <span className="dice-by">{r.by}</span>
                {r.label && <span className="dice-for">{r.label}</span>}
                {r.secret && <span className="chip warn">Secret</span>}
                <span className="dice-at">
                  {new Date(r.at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              <div className="dice-roll-body">
                <span className="dice-faces">
                  {r.dice.map((d, i) => (
                    <span
                      key={i}
                      className={`dice-face${d.kept ? "" : " dropped"}`}
                      title={
                        d.kept ? `d${d.sides}` : `d${d.sides}, dropped`
                      }
                    >
                      {d.value}
                    </span>
                  ))}
                  {r.dice.length === 0 && (
                    <span className="dice-face flat">—</span>
                  )}
                </span>
                <span className="dice-notation-read">{r.notation}</span>
                <span className="dice-total">{r.total}</span>
              </div>

              {crit && (
                <p className="dice-crit">
                  {crit === "high" ? "Natural 20" : "Natural 1"}
                </p>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
