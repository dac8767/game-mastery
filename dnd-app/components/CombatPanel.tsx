"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

type HpStatus = "healthy" | "injured" | "bloodied" | "down";

const STATUS_LABEL: Record<HpStatus, string> = {
  healthy: "Healthy",
  injured: "Injured",
  bloodied: "Bloodied",
  down: "Down",
};

const STATUS_COLOR: Record<HpStatus, string> = {
  healthy: "var(--healthy)",
  injured: "var(--injured)",
  bloodied: "var(--bloodied)",
  down: "var(--down)",
};

function statusFromHp(currentHp: number, maxHp: number): HpStatus {
  if (currentHp <= 0) return "down";
  if (currentHp <= maxHp / 2) return "bloodied";
  if (currentHp < maxHp) return "injured";
  return "healthy";
}

/**
 * Live initiative tracker — one subscription to combat.getEncounterView.
 *
 * The server shapes the payload per caller: players never receive hidden
 * combatants, masked HP numbers, or GM notes, so this component just
 * renders whatever arrives. Combatants with numeric HP get a bar; masked
 * ones get their narrative status bucket instead.
 */
export function CombatPanel({
  encounterId,
}: {
  encounterId: Id<"encounters">;
}) {
  const view = useQuery(api.combat.getEncounterView, { encounterId });

  if (view === undefined) {
    return (
      <section className="combat-panel">
        <div className="combat-header">
          <span className="muted">Loading encounter…</span>
        </div>
      </section>
    );
  }
  // null = encounter missing or still in prep (players aren't shown prep).
  if (view === null) return null;

  return (
    <section className="combat-panel">
      <div className="combat-header">
        <span className="encounter-name">{view.name}</span>
        <span className="round">
          {view.status === "ended"
            ? "Combat ended"
            : view.status === "active"
              ? `Round ${view.round}`
              : "Preparing…"}
        </span>
      </div>
      <ul className="combatant-list">
        {view.combatants.map((c) => {
          const isActive = view.activeCombatantId === c._id;
          const isDmView = c.view === "dm";
          const hp =
            c.currentHp !== null && c.currentHp !== undefined
              ? {
                  current: c.currentHp,
                  max: c.maxHp as number,
                  temp: (c.tempHp as number) ?? 0,
                }
              : null;
          const status: HpStatus = hp
            ? statusFromHp(hp.current, hp.max)
            : ((("hpStatus" in c ? c.hpStatus : undefined) ??
                "healthy") as HpStatus);

          return (
            <li
              key={c._id}
              className={[
                "combatant",
                isActive ? "active" : "",
                status === "down" ? "down-row" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="initiative">{c.initiative}</div>
              <div className="who">
                <div className="name">
                  {c.name}
                  <span className="kind">
                    {c.kind === "pc"
                      ? ""
                      : c.kind === "npc"
                        ? "NPC"
                        : "Monster"}
                  </span>
                </div>
                {(c.conditions.length > 0 ||
                  c.concentrating ||
                  (isDmView && c.hidden)) && (
                  <div className="chips">
                    {isDmView && c.hidden && (
                      <span className="chip">Hidden from players</span>
                    )}
                    {c.conditions.map((condition) => (
                      <span key={condition} className="chip">
                        {condition}
                      </span>
                    ))}
                    {c.concentrating && (
                      <span className="chip concentration">
                        Concentrating: {c.concentrating}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="hp">
                {hp ? (
                  <>
                    <span className="hp-numbers">
                      {hp.current}/{hp.max}
                      {hp.temp > 0 && <span className="temp">+{hp.temp}</span>}
                    </span>
                    <div className="hp-bar">
                      <div
                        className="fill"
                        style={{
                          width: `${
                            hp.max > 0
                              ? Math.max(
                                  0,
                                  Math.min(100, (hp.current / hp.max) * 100)
                                )
                              : 0
                          }%`,
                          background: STATUS_COLOR[status],
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <span className={`hp-status status-${status}`}>
                    {STATUS_LABEL[status]}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
