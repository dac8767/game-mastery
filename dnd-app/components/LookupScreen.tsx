"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import {
  LOOKUP_TABS,
  LOOKUP_TITLES,
  LookupKind,
} from "@/components/lookupFields";
import { LookupTool } from "@/components/LookupTool";

/**
 * The reference library, as one screen with seven tabs.
 *
 * It was seven sidebar entries and seven routes, which put the whole
 * rulebook down the left-hand side of every screen in the app and made
 * "look something up" a decision about WHICH list before it was a
 * search. One entry, one page, and the kind is a tab.
 *
 * The tab lives in the URL rather than in state, for two reasons that
 * are really one: a link to a species has to be able to name the tab
 * it lands on, and a screen you can send someone to is a screen you
 * can come back to.
 *
 * `key={tab}` is load-bearing. Filters, sort and the set of open rows
 * belong to a kind — a Casting Time filter means nothing on Items —
 * and without the key the same component instance would carry them
 * across, hiding rows on a tab whose filter bar shows nothing set.
 * Remounting is what the seven separate routes used to do for free.
 */
export function LookupScreen({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const params = useSearchParams();
  const router = useRouter();

  const asked = params.get("tab");
  // An unknown or absent tab lands on the first rather than on a blank
  // page — a stale bookmark from before a kind was renamed should not
  // be a dead end.
  const tab: LookupKind = LOOKUP_TABS.includes(asked as LookupKind)
    ? (asked as LookupKind)
    : LOOKUP_TABS[0];

  return (
    <div className="lookup-screen">
      <div className="settings-tabs" role="tablist" aria-label="Lookup">
        {LOOKUP_TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === tab}
            className={`settings-tab${k === tab ? " on" : ""}`}
            onClick={() =>
              // replace, not push: flipping through seven tabs should
              // not put seven entries in the back button between you
              // and the screen you came from.
              router.replace(`/campaign/${campaignId}/lookup?tab=${k}`, {
                scroll: false,
              })
            }
          >
            {LOOKUP_TITLES[k]}
          </button>
        ))}
      </div>

      <LookupTool key={tab} kind={tab} campaignId={campaignId} />
    </div>
  );
}
