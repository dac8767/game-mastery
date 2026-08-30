"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { DiceIcon } from "@/components/DiceIcon";
import { DiceCanvas } from "@/components/DiceCanvas";
import {
  STANDARD_DICE,
  addDie,
  adjustFlat,
  critOfDice,
  flatOf,
  groupDice,
  parseRoll,
} from "@/components/diceModel";

/**
 * The dice roller.
 *
 * Built as a TABLE rather than a form. You pick dice out of a tray at
 * the bottom, the pool reads back at you in the middle at the size of
 * something you are about to throw, and the result lands where you were
 * already looking. The first version was a column of small buttons
 * beside a list — a calculator that accepted dice notation. It could
 * roll anything and it made you feel nothing, which for a dice roller
 * is the whole failure.
 *
 * The dice are thrown on the SERVER; nothing here decides a number.
 * The parse happens twice on purpose: here it decides what the pool
 * reads and whether Roll is available, and in convex/dice.ts it decides
 * what is real. A client that produced its own faces would be a client
 * that could produce a 20 every time.
 *
 * The notation string is the single source of truth for the pool. The
 * tray writes to it, the modifier chips write to it, and you can still
 * type into it — so the buttons and the box can never disagree about
 * what is about to be rolled.
 *
 * A secret roll is the GM's. It never appears in a player's data at
 * all, so nothing here hides one: what arrives is already what the
 * caller is allowed to see.
 */

/** The nudges worth a button. Past these, type it. */
const MOD_STEPS = [1, 3, 5];

export function DiceRoller({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const view = useQuery(api.dice.listRolls, { campaignId });
  const table = useQuery(api.dice.getRoom, { campaignId });
  const rollDice = useMutation(api.dice.rollDice);
  const clearRolls = useMutation(api.dice.clearRolls);
  const setRoom = useMutation(api.dice.setRoom);

  const [notation, setNotation] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  /**
   * The roll whose dice are still in the air.
   *
   * Convex answers in milliseconds; the animation takes seconds. Left
   * alone, the total was readable well before the dice landed, which
   * makes the throw a re-enactment of something you already knew. The
   * log holds this one row back until the canvas says they stopped.
   */
  const [rolling, setRolling] = useState<string | null>(null);
  /** The theme's own rendered dice, when dddice has told us. */
  const [previews, setPreviews] = useState<Record<string, string> | null>(null);

  const isDm = view?.isDm ?? false;

  // What the pool currently means, if it means anything. Recomputed
  // per keystroke, which is free — a dozen characters of arithmetic.
  const parsed = useMemo(() => parseRoll(notation), [notation]);

  /** The roll everyone is looking at: the last one to land. */
  const latest = view?.rolls[0];

  /**
   * What the 3D canvas should throw — MY last roll and only mine.
   * dddice broadcasts a throw to the whole room, so a table where
   * every browser announced the same roll would draw it six times.
   * A secret roll is not sent at all: a hidden roll whose privacy
   * depends on another client honouring a flag is not hidden.
   */
  const toDraw = useMemo(
    () =>
      latest && latest.mine && !latest.secret
        ? { id: latest._id, dice: latest.dice }
        : null,
    [latest]
  );

  // Hold the newest roll the moment it is handed to the canvas, and
  // only then: a table with no dddice room never waits for anything.
  const drawId = toDraw?.id ?? null;
  const has3d = Boolean(table?.room);
  useEffect(() => {
    if (has3d && drawId) setRolling(drawId);
  }, [has3d, drawId]);

  async function throwDice(what: string, secret: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      setError(null);
      await rollDice({
        campaignId,
        notation: what,
        label: label.trim() || undefined,
        // The server ANDs this with GM status. Sending it from a
        // player's browser achieves nothing, which is the point.
        secret: secret || undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That roll didn't work.");
    } finally {
      setBusy(false);
    }
  }

  /** The dice have stopped: let the log show what they said. */
  const onSettled = useCallback((id: string) => {
    setRolling((held) => (held === id ? null : held));
  }, []);

  /** Swap the dice, keep the modifier. A +5 is not collateral. */
  function setDice(dice: string) {
    setNotation(adjustFlat(dice, flatOf(notation)));
  }

  if (view === undefined) {
    return <p className="centered-note">Fetching the dice…</p>;
  }

  return (
    <div className="dice">
      <section className="dice-stage">
        {/* Where the roll lands: the table's last roll, whoever threw
            it — the same thing everyone at a real table looks at when
            the dice stop. */}
        <div className="dice-felt">
          {table?.room && (
            <DiceCanvas
              slug={table.room.slug}
              passcode={table.room.passcode}
              theme={table.room.theme}
              roll={toDraw}
              onSettled={onSettled}
              onPreviews={setPreviews}
            />
          )}
          {/* With 3D dice running, the felt is the dice and nothing
              else — a summary printed over them says the answer before
              they land, and competes with the artwork behind them.
              Without a dddice room there would otherwise be nothing to
              look at, so the readout stays for that case. */}
          {!table?.room && (
            <div className="dice-felt-read">
              {latest ? (
                <RollFace roll={latest} big />
              ) : (
                <p className="dice-nothing">Nothing thrown yet.</p>
              )}
            </div>
          )}
        </div>

        {/* The pool, at the size of the thing you are about to throw. */}
        <div className="dice-pool">
          {parsed ? (
            <span className="dice-formula">{parsed.notation}</span>
          ) : notation.trim() === "" ? (
            <span className="dice-formula empty">Pick your dice</span>
          ) : (
            <span className="dice-formula bad">{notation}</span>
          )}
        </div>

        {error && <p className="form-error nb-error dice-error">{error}</p>}

        <div className="dice-mods">
          {MOD_STEPS.map((n) => (
            <button
              key={`p${n}`}
              type="button"
              className="dice-chip"
              onClick={() => setNotation((v) => adjustFlat(v, n))}
            >
              +{n}
            </button>
          ))}
          {MOD_STEPS.map((n) => (
            <button
              key={`m${n}`}
              type="button"
              className="dice-chip"
              onClick={() => setNotation((v) => adjustFlat(v, -n))}
            >
              −{n}
            </button>
          ))}
          <button
            type="button"
            className="dice-chip wide"
            title="Two d20, keep the higher"
            onClick={() => setDice("2d20kh1")}
          >
            ADV
          </button>
          <button
            type="button"
            className="dice-chip wide"
            title="Two d20, keep the lower"
            onClick={() => setDice("2d20kl1")}
          >
            DIS
          </button>
        </div>

        <div className="dice-actions">
          <button
            type="button"
            className="dice-roll-btn"
            disabled={!parsed || busy}
            onClick={() => parsed && void throwDice(parsed.notation, false)}
          >
            Roll!
          </button>
          {isDm && (
            <button
              type="button"
              className="dice-hidden-btn"
              disabled={!parsed || busy}
              title="Only you will see it"
              onClick={() => parsed && void throwDice(parsed.notation, true)}
            >
              Hidden Roll
            </button>
          )}
          <input
            className="dice-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What for?"
            maxLength={60}
            aria-label="Roll label"
          />
          <button
            type="button"
            className="dice-clear"
            title="Empty the pool"
            aria-label="Empty the pool"
            disabled={notation === ""}
            onClick={() => setNotation("")}
          >
            ✕
          </button>
        </div>

        {/* The tray. Click a die to add one of it — d6 eight times for
            8d6, then d4 four times for 8d6+4d4. Shapes rather than
            words, because picking a die out of a handful is something
            a player already knows how to do. */}
        <div className="dice-tray">
          {STANDARD_DICE.map((sides) => (
            <button
              key={sides}
              type="button"
              className="dice-tray-die"
              title={`Add a d${sides}`}
              aria-label={`Add a d${sides}`}
              onClick={() => setNotation((n) => addDie(n, sides))}
            >
              {/* dddice's own render of the die you are about to
                  throw, so the tray matches what lands. The drawn
                  icon stays as the fallback — it is what a table with
                  no dddice room sees, and what shows before the theme
                  has loaded. */}
              {previews?.[`d${sides}`] ? (
                <img src={previews[`d${sides}`]} alt="" />
              ) : (
                <DiceIcon sides={sides} />
              )}
            </button>
          ))}
        </div>

        {/* Still typeable, because a tray cannot express 4d6kh3 and
            somebody will always want to. Same state as everything
            above it. */}
        <input
          className="dice-notation"
          value={notation}
          onChange={(e) => setNotation(e.target.value)}
          placeholder="or type it: 8d6+4d4+3"
          maxLength={60}
          spellCheck={false}
          aria-label="Dice notation"
        />
      </section>

      <section className="dice-log">
        <header className="dice-log-head">
          <span className="dice-log-title">Rolls</span>
          {isDm && (
            <button
              type="button"
              className="text-button"
              onClick={() => setSetup((v) => !v)}
            >
              {table?.room ? "3D dice" : "Add 3D dice"}
            </button>
          )}
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

        {isDm && setup && (
          <DddiceSetup
            room={table?.room ?? null}
            onSave={(slug, passcode, theme, enabled) => {
              void setRoom({ campaignId, slug, passcode, theme, enabled })
                .then(() => setSetup(false))
                .catch((e: unknown) =>
                  setError(
                    e instanceof Error ? e.message : "Couldn't save that."
                  )
                );
            }}
          />
        )}

        {view.rolls.length === 0 && (
          <p className="centered-note">No rolls yet.</p>
        )}

        {view.rolls.map((r) => (
          <RollFace key={r._id} roll={r} rolling={r._id === rolling} />
        ))}
      </section>
    </div>
  );
}

type LoggedRoll = {
  _id: string;
  at: number;
  by: string;
  mine: boolean;
  notation: string;
  label: string | null;
  dice: { sides: number; value: number; kept: boolean; t?: number }[];
  mod: number;
  total: number;
  secret: boolean;
};

/**
 * One roll, read back.
 *
 * The same component on the felt and in the log, at two sizes, so the
 * roll that just landed and the roll three rows down cannot end up
 * disagreeing about what a dropped die looks like.
 */
function RollFace({
  roll,
  big = false,
  rolling = false,
}: {
  roll: LoggedRoll;
  big?: boolean;
  rolling?: boolean;
}) {
  const crit = critOfDice(roll.dice);
  const groups = groupDice(roll.dice);

  return (
    <article
      className={`dice-roll${big ? " big" : ""}${roll.mine ? " mine" : ""}${
        roll.secret ? " secret" : ""
      }${crit ? ` crit-${crit}` : ""}`}
    >
      <div className="dice-roll-head">
        <span className="dice-by">{roll.by}</span>
        {roll.label && <span className="dice-for">{roll.label}</span>}
        {roll.secret && <span className="chip warn">Secret</span>}
        <span className="dice-at">
          {new Date(roll.at).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </div>

      {/* Still in the air. The row exists — you can see the roll was
          made — but the number waits for the dice to say it. */}
      {rolling ? (
        <p className="dice-rolling">Rolling…</p>
      ) : (
      <div className="dice-roll-body">
        {/* Grouped, so "8d6+4d4+3" reads as two handfuls and a
            modifier rather than twelve numbers in a row with nothing
            to say where the d6s stop. A single group goes unlabelled —
            "1d20" over one die is noise. */}
        <span className="dice-groups">
          {groups.map((g, gi) => (
            <span className="dice-group" key={gi}>
              {groups.length > 1 && (
                <span className="dice-group-label">{g.label}</span>
              )}
              {g.dice.map((d, i) => (
                <span
                  key={i}
                  className={`dice-face${d.kept ? "" : " dropped"}`}
                  title={d.kept ? `d${d.sides}` : `d${d.sides}, dropped`}
                >
                  {d.value}
                </span>
              ))}
            </span>
          ))}
          {roll.mod !== 0 && (
            <span className="dice-face flat" title="Modifier">
              {roll.mod > 0 ? `+${roll.mod}` : roll.mod}
            </span>
          )}
          {groups.length === 0 && roll.mod === 0 && (
            <span className="dice-face flat">—</span>
          )}
        </span>
        <span className="dice-notation-read">{roll.notation}</span>
        <span className="dice-total">{roll.total}</span>
      </div>
      )}

      {!rolling && crit && (
        <p className="dice-crit">
          {crit === "high" ? "Natural 20" : "Natural 1"}
        </p>
      )}
    </article>
  );
}

/**
 * The GM's dddice settings.
 *
 * A room slug and, for a private room, its passcode. No API key: every
 * browser makes its own dddice guest account, so there is no
 * credential of the GM's to type here and none to leak.
 *
 * The passcode does reach the players' browsers — a private room needs
 * it to join, and the players are the ones joining. It goes only to
 * campaign members, through a query that checks that first.
 */
function DddiceSetup({
  room,
  onSave,
}: {
  room: { slug: string; passcode: string | null; theme: string | null } | null;
  onSave: (
    slug: string,
    passcode: string | undefined,
    theme: string | undefined,
    enabled: boolean
  ) => void;
}) {
  const [slug, setSlug] = useState(room?.slug ?? "");
  const [passcode, setPasscode] = useState(room?.passcode ?? "");
  const [theme, setTheme] = useState(room?.theme ?? "");

  return (
    <form
      className="dice-setup"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(slug, passcode || undefined, theme || undefined, slug !== "");
      }}
    >
      <p className="dice-setup-note">
        Paste your dddice room link. Everyone at the table joins as a
        guest — no keys to share.
      </p>
      <input
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        placeholder="dddice.com/room/XXXXXXX"
        aria-label="dddice room"
      />
      <input
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        placeholder="Passcode (private rooms only)"
        aria-label="Room passcode"
      />
      <input
        value={theme}
        onChange={(e) => setTheme(e.target.value)}
        placeholder="Theme, e.g. dddice-bees (optional)"
        aria-label="Dice theme"
      />
      <div className="dice-setup-go">
        <button type="submit" className="npc-btn primary">
          Save
        </button>
        {room && (
          <button
            type="button"
            className="text-button"
            onClick={() => onSave(room.slug, undefined, undefined, false)}
          >
            Turn off
          </button>
        )}
      </div>
    </form>
  );
}
