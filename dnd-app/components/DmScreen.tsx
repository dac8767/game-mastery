"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { RibbonBar } from "@/components/RibbonBar";

/**
 * The DM Screen — the physical screen you sit behind, made of pixels.
 *
 * This is the ribbon's only home. Every other screen gets its full
 * height back for the thing it is showing.
 *
 * The DM check here hides a screen; it does not protect data. Nothing on
 * this page is secret — a person's own toolbar layout and the conditions
 * table are both things a player may see — so the honest description is
 * "this is not for you" rather than "you are not authorised". Anything
 * added here that IS secret must be gated in its own Convex function,
 * where authority is structural and a client cannot argue with it.
 */

/** The 5e conditions, and the one line about each you actually forget. */
const CONDITIONS: { name: string; effect: string }[] = [
  { name: "Blinded", effect: "Auto-fail sight checks. Attacks against have advantage; yours have disadvantage." },
  { name: "Charmed", effect: "Can't attack the charmer. The charmer has advantage on social checks." },
  { name: "Deafened", effect: "Auto-fail hearing checks." },
  { name: "Frightened", effect: "Disadvantage while the source is in sight. Can't willingly move closer." },
  { name: "Grappled", effect: "Speed 0. Ends if the grappler is incapacitated or you're moved away." },
  { name: "Incapacitated", effect: "No actions, no reactions." },
  { name: "Invisible", effect: "Heavily obscured. Attacks against have disadvantage; yours have advantage." },
  { name: "Paralyzed", effect: "Incapacitated, can't move or speak, auto-fail STR/DEX saves. Hits within 5 ft are crits." },
  { name: "Petrified", effect: "Turned to stone. Incapacitated, resistance to all damage, immune to poison and disease." },
  { name: "Poisoned", effect: "Disadvantage on attacks and ability checks." },
  { name: "Prone", effect: "Crawl or stand. Disadvantage on attacks; melee against has advantage, ranged disadvantage." },
  { name: "Restrained", effect: "Speed 0. Attacks against have advantage; yours have disadvantage. Disadvantage on DEX saves." },
  { name: "Stunned", effect: "Incapacitated, can't move, speaks falteringly, auto-fail STR/DEX saves." },
  { name: "Unconscious", effect: "Incapacitated, drops everything, prone. Hits within 5 ft are crits." },
  { name: "Exhaustion", effect: "1 disadv. checks · 2 speed halved · 3 disadv. attacks/saves · 4 HP max halved · 5 speed 0 · 6 death." },
];

const DEATH_SAVES =
  "DC 10. Three successes stabilise, three failures kill. A nat 20 " +
  "restores 1 HP; a nat 1 counts as two failures. Damage while down is " +
  "an automatic failure, and a crit is two.";

export function DmScreen({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const campaigns = useQuery(api.campaigns.myCampaigns);

  if (campaigns === undefined) {
    return <p className="centered-note">Loading…</p>;
  }

  const campaign = campaigns.find((c) => c._id === campaignId) ?? null;
  if (!campaign?.isDm) {
    return (
      <p className="centered-note">
        The DM Screen is the DM&apos;s side of the table. Nothing to see
        from this chair.
      </p>
    );
  }

  return (
    <div className="dmscreen">
      <RibbonBar campaignId={campaignId} />

      <section className="dmscreen-panel">
        <h2>Conditions</h2>
        <dl className="dmscreen-ref">
          {CONDITIONS.map((c) => (
            <div key={c.name}>
              <dt>{c.name}</dt>
              <dd>{c.effect}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="dmscreen-panel">
        <h2>Death saves</h2>
        <p className="muted">{DEATH_SAVES}</p>
      </section>

      <p className="settings-note">
        The toolbar above is yours alone — arrange it with Customize and
        nobody else&apos;s changes.
      </p>
    </div>
  );
}
