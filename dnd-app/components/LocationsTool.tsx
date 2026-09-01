"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { useSearchParams } from "next/navigation";
import { Id } from "@/convex/_generated/dataModel";
import {
  LocRow,
  ancestorsOf,
  childrenOf,
  clampPin,
  hasMap,
  isPinned,
  mapSrc,
  moveTargets,
  pinnedOf,
  unpinnedOf,
} from "@/components/locationTree";

/**
 * Locations: a region map you descend into.
 *
 * Tier 1 is a region — towns and cities marked on it as pins. Click a
 * pin for the place's details and pictures; DOUBLE-click one whose
 * location has a map of its own and you zoom into that map, where the
 * same pattern repeats. It goes down as far as the GM builds it, to a
 * battle map if they want.
 *
 * Which map you are looking at is local state, not a route: descending
 * and coming back up is navigation within one screen, and pushing a
 * history entry per pin would make the back button mean something
 * different every level.
 *
 * A pin is not the same thing as a child, and the difference is the
 * subtlety in this screen. Every pin is a child, but a child with no
 * (x, y) is a place that belongs here and has not been drawn — which
 * the app's own rules produce routinely, since deleting a location
 * promotes its children with their pins cleared. Those go in the strip
 * under the map. Rendering only the pins is what made a promoted
 * district unreachable.
 */

type Result = FunctionReturnType<typeof api.locations.listForCampaign>;
type Loc = Result["locations"][number];

/** Uploaded maps and pictures are capped so one scan can't dominate. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Mirrors MAX_PICTURES in convex/locations.ts, which is the one that
 * actually enforces it. Held here so the button can go quiet at the
 * limit instead of offering an upload the server will refuse after the
 * GM has waited for it. The integrity guard pins the two together.
 */
const MAX_PICTURES = 12;

/**
 * What a click on the map means right now.
 *
 * A boolean covered only "the next click makes a new location", which
 * left the GM no way to give an existing one a position — the arrow
 * nudges move a pin that is already somewhere, and a place with no pin
 * has nowhere to be nudged from.
 */
type Placing = { kind: "new" } | { kind: "move"; id: string } | null;

export function LocationsTool({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const data = useQuery(api.locations.listForCampaign, { campaignId });
  const createLocation = useMutation(api.locations.createLocation);
  const updateLocation = useMutation(api.locations.updateLocation);
  const deleteLocation = useMutation(api.locations.deleteLocation);
  const setPin = useMutation(api.locations.setPin);

  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState<Placing>(null);
  const [error, setError] = useState<string | null>(null);

  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const locations = useMemo(() => data?.locations ?? [], [data]);
  const isDm = data?.isDm ?? false;

  /* ?open=<name> — how an NPC's Place field sends you here.
     A NAME, because that field is free text typed into Airtable, and
     a place that matches nothing is a normal outcome: you land on the
     locations screen rather than on an error. Opened once per name,
     tracked in a ref rather than derived from state, or closing the
     one you were sent to would reopen it on the next render. */
  const params = useSearchParams();
  const openName = params.get("open");
  const handledOpen = useRef<string | null>(null);
  useEffect(() => {
    if (!openName || locations.length === 0) return;
    if (handledOpen.current === openName) return;
    const want = openName.replace(/\s+/g, " ").trim().toLowerCase();
    const found = locations.find(
      (l) => String(l.name ?? "").replace(/\s+/g, " ").trim().toLowerCase() === want
    );
    if (!found) return;
    handledOpen.current = openName;
    setSelectedId(found._id);
    // Its parent is what has the map the pin sits on; opening the
    // place itself would show an empty map for anything that is a pin
    // rather than a scene.
    setOpenId((cur) => cur ?? (found.parentId ? String(found.parentId) : null));
  }, [openName, locations]);

  /**
   * Selecting anything disarms a pending placement.
   *
   * A move is armed against ONE location and shows as "Click the map…"
   * on that location's own panel. Selecting a different place leaves
   * the indicator off screen while the next map click still moves the
   * place the GM has stopped looking at — so the selection change
   * cancels it, rather than leaving an armed action with nothing on
   * screen that says so.
   */
  const select = (id: string | null) => {
    setSelectedId(id);
    setPlacing(null);
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  };

  if (data === undefined) {
    return <p className="centered-note">Loading locations…</p>;
  }

  const rows = locations as unknown as LocRow[];
  const open = openId ? (locations.find((l) => l._id === openId) ?? null) : null;
  const trail = openId ? ancestorsOf(rows, openId) : [];
  const children = childrenOf(rows, openId);
  const pins = pinnedOf(rows, openId);
  const unplaced = unpinnedOf(rows, openId);
  const selected = selectedId
    ? (locations.find((l) => l._id === selectedId) ?? null)
    : null;

  const src = open
    ? mapSrc(open.mapUrl, open.mapPath, mapServer)
    : null;

  /* A place can only be pinned onto the map it actually belongs to, so
     this asks for the literal parent rather than using childrenOf —
     which promotes an orphan to the root on purpose and would offer to
     pin a district onto a region it does not sit in. */
  const canPlaceSelected = Boolean(
    isDm && open && src && selected && selected.parentId === open._id
  );

  /** A click on the map, as a normalized position on the image. */
  const posFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: clampPin((e.clientX - box.left) / box.width),
      y: clampPin((e.clientY - box.top) / box.height),
    };
  };

  return (
    <div className="loc">
      <div className="loc-bar">
        <button
          type="button"
          className="npc-btn"
          onClick={() => {
            setOpenId(null);
            setSelectedId(null);
            setPlacing(null);
          }}
        >
          Atlas
        </button>
        {trail.map((t) => (
          <span key={t._id} className="loc-crumb">
            <span className="sep">›</span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setOpenId(t._id);
                setSelectedId(null);
                setPlacing(null);
              }}
            >
              {t.name}
            </button>
          </span>
        ))}

        {isDm && (
          <div className="loc-bar-actions">
            {open && src && (
              <button
                type="button"
                className={`npc-btn${placing ? " primary" : ""}`}
                onClick={() =>
                  setPlacing((p) => (p ? null : { kind: "new" }))
                }
              >
                {placing ? "Click the map…" : "Add a pin"}
              </button>
            )}
            {!open && (
              <button
                type="button"
                className="npc-btn"
                onClick={() =>
                  void run(async () => {
                    const id = await createLocation({
                      campaignId,
                      name: "New region",
                    });
                    setSelectedId(id);
                  })
                }
              >
                New region
              </button>
            )}
          </div>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="loc-body">
        <div className="loc-stage">
          {open && src ? (
            <>
              <div
                className={`loc-map${placing ? " placing" : ""}`}
                onClick={(e) => {
                  if (!placing || !isDm) return;
                  const { x, y } = posFromEvent(e);
                  const mode = placing;
                  setPlacing(null);
                  void run(async () => {
                    if (mode.kind === "move") {
                      await setPin({
                        locationId: mode.id as Id<"locations">,
                        x,
                        y,
                      });
                      setSelectedId(mode.id);
                      return;
                    }
                    const id = await createLocation({
                      campaignId,
                      name: "New location",
                      parentId: open._id,
                      x,
                      y,
                    });
                    setSelectedId(id);
                  });
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={open.name} />

                {pins.map((pin) => (
                  <button
                    key={pin._id}
                    type="button"
                    className={`loc-pin${
                      selectedId === pin._id ? " selected" : ""
                    }${hasMap(pin) ? " has-map" : ""}`}
                    style={{
                      left: `${(pin.x ?? 0) * 100}%`,
                      top: `${(pin.y ?? 0) * 100}%`,
                    }}
                    title={
                      hasMap(pin)
                        ? `${pin.name} — double-click to enter`
                        : pin.name
                    }
                    onClick={(e) => {
                      // While placing, a pin is part of the map rather
                      // than a target: swallowing the click here would
                      // make the busiest part of the image the one
                      // place a pin cannot go.
                      if (placing) return;
                      e.stopPropagation();
                      setSelectedId(pin._id);
                    }}
                    onDoubleClick={(e) => {
                      if (placing) return;
                      e.stopPropagation();
                      // Only descend where there is something to descend
                      // into; a pin with no map of its own just opens.
                      if (!hasMap(pin)) return;
                      setOpenId(pin._id);
                      setSelectedId(null);
                    }}
                  >
                    <span className="loc-pin-dot" />
                    <span className="loc-pin-label">{pin.name}</span>
                  </button>
                ))}
              </div>

              <UnpinnedStrip
                rows={unplaced}
                locations={locations}
                isDm={isDm}
                selectedId={selectedId}
                onSelect={select}
                onOpen={(id) => {
                  setOpenId(id);
                  setSelectedId(null);
                  setPlacing(null);
                }}
              />
            </>
          ) : (
            <LocationList
              rows={children}
              locations={locations}
              onOpen={(id) => {
                setOpenId(id);
                setSelectedId(null);
              }}
              onSelect={select}
              selectedId={selectedId}
              emptyNote={
                open
                  ? isDm
                    ? "This place has no map yet. Upload one in the panel and its pins appear here."
                    : "No map for this place yet."
                  : isDm
                    ? "No regions yet. Start with a region map."
                    : "The atlas is empty so far."
              }
            />
          )}
        </div>

        <aside className="loc-panel">
          {selected ? (
            <LocationDetail
              key={selected._id}
              loc={selected}
              rows={rows}
              isDm={isDm}
              mapServer={mapServer}
              canEnter={hasMap(selected)}
              onEnter={() => {
                setOpenId(selected._id);
                setSelectedId(null);
                setPlacing(null);
              }}
              canPlace={canPlaceSelected}
              placingThis={
                placing?.kind === "move" && placing.id === selected._id
              }
              onPlace={() =>
                setPlacing((p) =>
                  p?.kind === "move" && p.id === selected._id
                    ? null
                    : { kind: "move", id: selected._id }
                )
              }
              onChange={(patch) =>
                void run(() =>
                  updateLocation({
                    locationId: selected._id,
                    ...patch,
                  })
                )
              }
              onDelete={() =>
                void run(async () => {
                  await deleteLocation({ locationId: selected._id });
                  setSelectedId(null);
                  setPlacing(null);
                })
              }
              onMove={(x, y) =>
                void run(() => setPin({ locationId: selected._id, x, y }))
              }
            />
          ) : (
            <p className="muted loc-hint">
              {open
                ? "Click a pin to see the place. Double-click one with its own map to go in."
                : "Pick a region to open its map."}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The places that belong to this map but are not drawn on it.
 *
 * Without this they were rendered nowhere at all — the map branch skips
 * a child with no coordinates, and the list is only the fallback for a
 * place that has no map. So promoting a city's districts (which clears
 * their pins, because the coordinates named the city's map) hid them,
 * and the cascade the delete rule avoids happened anyway, one level up
 * and silently.
 */
function UnpinnedStrip({
  rows,
  locations,
  isDm,
  selectedId,
  onSelect,
  onOpen,
}: {
  rows: LocRow[];
  locations: Loc[];
  isDm: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="loc-unpinned">
      <div className="loc-unpinned-head">
        <span className="detail-label">Not on the map</span>
        <span className="muted">
          {isDm
            ? "Pick one, then “Place on map” in the panel."
            : "These places are here, but the map does not mark them."}
        </span>
      </div>
      <ul>
        {rows.map((r) => {
          const full = locations.find((l) => l._id === r._id);
          return (
            <li key={r._id}>
              <button
                type="button"
                className={`loc-chip${selectedId === r._id ? " selected" : ""}`}
                onClick={() => onSelect(r._id)}
                onDoubleClick={() => hasMap(r) && onOpen(r._id)}
                title={
                  hasMap(r) ? `${r.name} — double-click to enter` : r.name
                }
              >
                <span className="loc-list-name">{r.name}</span>
                {hasMap(r) && <span className="loc-tag">map</span>}
                {full?.hidden && (
                  <span className="loc-tag hidden-tag">hidden</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The fallback when there is no map to pin things onto. */
function LocationList({
  rows,
  locations,
  onOpen,
  onSelect,
  selectedId,
  emptyNote,
}: {
  rows: LocRow[];
  locations: Loc[];
  onOpen: (id: string) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
  emptyNote: string;
}) {
  if (rows.length === 0) {
    return <p className="centered-note">{emptyNote}</p>;
  }
  return (
    <ul className="loc-list">
      {rows.map((r) => {
        const full = locations.find((l) => l._id === r._id);
        return (
          <li key={r._id}>
            <button
              type="button"
              className={`loc-list-item${
                selectedId === r._id ? " selected" : ""
              }`}
              onClick={() => onSelect(r._id)}
              onDoubleClick={() => hasMap(r) && onOpen(r._id)}
            >
              <span className="loc-list-name">{r.name}</span>
              {hasMap(r) && <span className="loc-tag">map</span>}
              {full?.hidden && <span className="loc-tag hidden-tag">hidden</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function LocationDetail({
  loc,
  rows,
  isDm,
  mapServer,
  canEnter,
  onEnter,
  canPlace,
  placingThis,
  onPlace,
  onChange,
  onDelete,
  onMove,
}: {
  loc: Loc;
  rows: LocRow[];
  isDm: boolean;
  mapServer: string;
  canEnter: boolean;
  onEnter: () => void;
  canPlace: boolean;
  placingThis: boolean;
  onPlace: () => void;
  onChange: (patch: {
    name?: string;
    description?: string | null;
    dmNotes?: string | null;
    hidden?: boolean;
    parentId?: Id<"locations"> | null;
  }) => void;
  onDelete: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const [name, setName] = useState(loc.name);
  const [description, setDescription] = useState(loc.description ?? "");
  const [dmNotes, setDmNotes] = useState(loc.dmNotes ?? "");

  // isPinned rather than a fourth spelling of the same test: the map
  // layer, the strip and this button have to agree on what "placed"
  // means, and a local `loc.x !== null` drifts the moment the rule
  // changes — the origin and the half-written pin are exactly where
  // it would drift.
  const pinned = isPinned(loc);

  return (
    <div className="loc-detail">
      <header className="loc-detail-head">
        {isDm ? (
          <input
            className="detail-input loc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== loc.name && onChange({ name })}
          />
        ) : (
          <h2>{loc.name}</h2>
        )}
        {canEnter && (
          <button type="button" className="npc-btn" onClick={onEnter}>
            Enter
          </button>
        )}
      </header>

      <PictureField loc={loc} isDm={isDm} />

      <div className="detail-field">
        <div className="detail-label">Description</div>
        {isDm ? (
          <textarea
            className="detail-input"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() =>
              description !== (loc.description ?? "") &&
              onChange({ description: description.trim() || null })
            }
          />
        ) : (
          <div className="detail-value">{loc.description ?? "—"}</div>
        )}
      </div>

      {isDm && (
        <>
          <div className="detail-field dm-field">
            <div className="detail-label">
              GM notes<span className="dm-tag">GM only</span>
            </div>
            <textarea
              className="detail-input"
              rows={3}
              value={dmNotes}
              onChange={(e) => setDmNotes(e.target.value)}
              onBlur={() =>
                dmNotes !== (loc.dmNotes ?? "") &&
                onChange({ dmNotes: dmNotes.trim() || null })
              }
            />
          </div>

          {/* Where it sits in the tree. Offered as a picker rather than
              left to delete-and-recreate: a place carries its
              description, its GM notes, its pictures and its own map,
              and rebuilding one to correct its parent throws all of
              that away. moveTargets asks the same question the server
              asks, so a move that would be refused is never offered. */}
          <div className="detail-field">
            <div className="detail-label">Inside</div>
            <select
              className="detail-input"
              value={loc.parentId ? String(loc.parentId) : ""}
              onChange={(e) =>
                onChange({
                  parentId: e.target.value
                    ? (e.target.value as Id<"locations">)
                    : null,
                })
              }
            >
              {/* The top level is a real answer, not a missing one. */}
              <option value="">The atlas</option>
              {moveTargets(rows, loc._id).map(({ row, depth }) => (
                <option key={row._id} value={row._id}>
                  {"\u00A0\u00A0".repeat(depth)}
                  {row.name}
                </option>
              ))}
            </select>
            <p className="settings-note">
              Moving it clears its pin — the coordinates named a spot on
              the map it is leaving. It arrives under “Not on the map”.
            </p>
          </div>

          <label className="detail-check">
            <input
              type="checkbox"
              checked={loc.hidden}
              onChange={(e) => onChange({ hidden: e.target.checked })}
            />
            <span>Hidden from players</span>
          </label>
          <p className="settings-note">
            Hiding a place does not hide what is inside it — a district the
            players know stays reachable even when its city does not.
          </p>

          <MapField loc={loc} mapServer={mapServer} />

          {canPlace && (
            <div className="detail-field">
              <div className="detail-label">Pin</div>
              <button
                type="button"
                className={`npc-btn${placingThis ? " primary" : ""}`}
                onClick={onPlace}
              >
                {placingThis
                  ? "Click the map…"
                  : pinned
                    ? "Move pin on map"
                    : "Place on map"}
              </button>
              {pinned && (
                <div className="loc-nudge">
                  <button type="button" onClick={() => onMove((loc.x ?? 0) - 0.01, loc.y ?? 0)}>←</button>
                  <button type="button" onClick={() => onMove((loc.x ?? 0) + 0.01, loc.y ?? 0)}>→</button>
                  <button type="button" onClick={() => onMove(loc.x ?? 0, (loc.y ?? 0) - 0.01)}>↑</button>
                  <button type="button" onClick={() => onMove(loc.x ?? 0, (loc.y ?? 0) + 0.01)}>↓</button>
                </div>
              )}
            </div>
          )}

          <button type="button" className="text-button loc-delete" onClick={onDelete}>
            Delete this location
          </button>
          <p className="settings-note">
            Anything inside it moves up a level rather than being deleted
            with it, and arrives under “Not on the map”.
          </p>
        </>
      )}
    </div>
  );
}

/** The location's own map — what makes it something you can descend into. */
function MapField({ loc, mapServer }: { loc: Loc; mapServer: string }) {
  const generateUrl = useMutation(api.locations.generateUploadUrl);
  const setMap = useMutation(api.locations.setMap);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const src = mapSrc(loc.mapUrl, loc.mapPath, mapServer);

  async function upload(file: File) {
    if (file.size > MAX_IMAGE_BYTES) {
      setError("That image is over 12MB — shrink it first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = await generateUrl({ locationId: loc._id });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) throw new Error("The upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      await setMap({
        locationId: loc._id,
        storageId: storageId as Parameters<typeof setMap>[0]["storageId"],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-field">
      <div className="detail-label">Map</div>
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="loc-map-thumb" src={src} alt={`${loc.name} map`} />
      ) : (
        <div className="portrait-empty">No map — this place is an endpoint</div>
      )}
      <div className="portrait-actions">
        <button
          type="button"
          className="npc-btn"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Uploading…" : src ? "Replace map" : "Upload a map"}
        </button>
        {loc.mapUrl && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void setMap({ locationId: loc._id, storageId: null })
            }
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/**
 * Pictures of the place itself, as distinct from its map.
 *
 * The gallery and its controls are one component because they are one
 * thing: a picture the GM can see but not remove is what this was
 * before, and the reason was upstream — the query handed back urls
 * only, and removePicture names a picture by storage id. Nothing in
 * the UI could ask for a removal it had no id for.
 */
function PictureField({ loc, isDm }: { loc: Loc; isDm: boolean }) {
  const generateUrl = useMutation(api.locations.generateUploadUrl);
  const addPicture = useMutation(api.locations.addPicture);
  const removePicture = useMutation(api.locations.removePicture);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pictures = loc.pictures;
  const full = pictures.length >= MAX_PICTURES;

  // A player with no pictures gets no empty frame — there is nothing
  // to show and nothing they could do about it.
  if (!isDm && pictures.length === 0) return null;

  async function upload(file: File) {
    if (file.size > MAX_IMAGE_BYTES) {
      setError("That image is over 12MB — shrink it first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = await generateUrl({ locationId: loc._id });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) throw new Error("The upload failed.");
      const { storageId } = (await res.json()) as { storageId: string };
      await addPicture({
        locationId: loc._id,
        storageId: storageId as Parameters<typeof addPicture>[0]["storageId"],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(storageId: (typeof pictures)[number]["id"]) {
    setBusy(true);
    setError(null);
    try {
      await removePicture({ locationId: loc._id, storageId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-field">
      <div className="detail-label">Pictures</div>

      {pictures.length > 0 && (
        <div className="loc-pictures">
          {pictures.map((p) => (
            <div key={p.id} className="loc-picture">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={loc.name} />
              {isDm && (
                <button
                  type="button"
                  className="loc-picture-remove"
                  title="Remove this picture"
                  disabled={busy}
                  onClick={() => void remove(p.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isDm && (
        <>
          <div className="portrait-actions">
            <button
              type="button"
              className="npc-btn"
              disabled={busy || full}
              title={
                full
                  ? `A location holds at most ${MAX_PICTURES} pictures.`
                  : undefined
              }
              onClick={() => input.current?.click()}
            >
              {busy ? "Uploading…" : "Add a picture"}
            </button>
            <span className="muted">
              {pictures.length} of {MAX_PICTURES}
            </span>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
