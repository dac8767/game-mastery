"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { CombatPanel } from "@/components/CombatPanel";

/**
 * The player's table: one subscription to maps.getTableState drives the
 * whole screen. When the GM switches maps, toggles the grid, or posts a
 * banner, every player's screen follows instantly.
 *
 * Image URLs are `${NEXT_PUBLIC_MAP_SERVER}/${webPath}` — served from the
 * PowerEdge through the Cloudflare tunnel. Players must have passed
 * Cloudflare Access once in their browser or the <img> will 403.
 */
export function TableScreen({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const tableState = useQuery(api.maps.getTableState, { campaignId });
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";

  if (tableState === undefined) {
    return <p className="centered-note">Joining the table…</p>;
  }
  if (tableState === null) {
    return (
      <p className="centered-note">
        This campaign&apos;s table hasn&apos;t been set up yet.
      </p>
    );
  }

  const { activeMap, showGrid, banner, activeEncounterId } = tableState;

  // The grid overlay is drawn from square counts (resolution-independent),
  // never from gridSizePx — the web-res copies are downscaled, so original
  // pixel measurements don't apply to what players actually load.
  const gridReady =
    showGrid &&
    activeMap !== null &&
    activeMap.widthSquares !== null &&
    activeMap.heightSquares !== null &&
    activeMap.widthSquares > 0 &&
    activeMap.heightSquares > 0;

  return (
    <div>
      {banner && <div className="banner">{banner}</div>}

      {activeMap ? (
        <>
          <div className="map-frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${mapServer}/${activeMap.webPath}`}
              alt={activeMap.title}
            />
            {gridReady && (
              <div
                className="grid-overlay"
                style={{
                  backgroundSize: `${100 / activeMap.widthSquares!}% ${
                    100 / activeMap.heightSquares!
                  }%`,
                }}
              />
            )}
          </div>
          <p className="map-title">{activeMap.title}</p>
        </>
      ) : (
        <div className="empty-table">
          The table is empty — waiting for the GM to set a scene.
        </div>
      )}

      {activeEncounterId && <CombatPanel encounterId={activeEncounterId} />}
    </div>
  );
}
