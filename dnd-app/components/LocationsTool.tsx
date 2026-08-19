"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  LocRow,
  ancestorsOf,
  childrenOf,
  clampPin,
  hasMap,
  mapSrc,
} from "@/components/locationTree";

/**
 * Locations: a region map you descend into.
 *
 * Tier 1 is a region — towns and cities marked on it as pins. Click a
 * pin for the place's details and pictures; DOUBLE-click one whose
 * location has a map of its own and you zoom into that map, where the
 * same pattern repeats. It goes down as far as the DM builds it, to a
 * battle map if they want.
 *
 * Which map you are looking at is local state, not a route: descending
 * and coming back up is navigation within one screen, and pushing a
 * history entry per pin would make the back button mean something
 * different every level.
 */

type Result = FunctionReturnType<typeof api.locations.listForCampaign>;
type Loc = Result["locations"][number];

/** Uploaded maps and pictures are capped so one scan can't dominate. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

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
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const locations = useMemo(() => data?.locations ?? [], [data]);
  const isDm = data?.isDm ?? false;

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
  const pins = childrenOf(rows, openId);
  const selected = selectedId
    ? (locations.find((l) => l._id === selectedId) ?? null)
    : null;

  const src = open
    ? mapSrc(open.mapUrl, open.mapPath, mapServer)
    : null;

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
            setPlacing(false);
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
                setPlacing(false);
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
                onClick={() => setPlacing((p) => !p)}
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
            <div
              className={`loc-map${placing ? " placing" : ""}`}
              onClick={(e) => {
                if (!placing || !isDm) return;
                const { x, y } = posFromEvent(e);
                setPlacing(false);
                void run(async () => {
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

              {pins.map((pin) => {
                // A child with no pin belongs to this place but was never
                // placed on the map — it shows in the panel's list, not
                // at coordinates it doesn't have.
                if (pin.x === null || pin.x === undefined) return null;
                return (
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
                      e.stopPropagation();
                      setSelectedId(pin._id);
                    }}
                    onDoubleClick={(e) => {
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
                );
              })}
            </div>
          ) : (
            <LocationList
              rows={pins}
              locations={locations}
              onOpen={(id) => {
                setOpenId(id);
                setSelectedId(null);
              }}
              onSelect={setSelectedId}
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
              isDm={isDm}
              mapServer={mapServer}
              canEnter={hasMap(selected)}
              onEnter={() => {
                setOpenId(selected._id);
                setSelectedId(null);
              }}
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
  isDm,
  mapServer,
  canEnter,
  onEnter,
  onChange,
  onDelete,
  onMove,
}: {
  loc: Loc;
  isDm: boolean;
  mapServer: string;
  canEnter: boolean;
  onEnter: () => void;
  onChange: (patch: {
    name?: string;
    description?: string | null;
    dmNotes?: string | null;
    hidden?: boolean;
  }) => void;
  onDelete: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const [name, setName] = useState(loc.name);
  const [description, setDescription] = useState(loc.description ?? "");
  const [dmNotes, setDmNotes] = useState(loc.dmNotes ?? "");

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

      {loc.pictureUrls.length > 0 && (
        <div className="loc-pictures">
          {loc.pictureUrls.map((u) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={u} src={u} alt={loc.name} />
          ))}
        </div>
      )}

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
              DM notes<span className="dm-tag">DM only</span>
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
          <PictureField loc={loc} />

          {loc.x !== null && (
            <div className="loc-nudge">
              <span className="detail-label">Pin</span>
              <button type="button" onClick={() => onMove((loc.x ?? 0) - 0.01, loc.y ?? 0)}>←</button>
              <button type="button" onClick={() => onMove((loc.x ?? 0) + 0.01, loc.y ?? 0)}>→</button>
              <button type="button" onClick={() => onMove(loc.x ?? 0, (loc.y ?? 0) - 0.01)}>↑</button>
              <button type="button" onClick={() => onMove(loc.x ?? 0, (loc.y ?? 0) + 0.01)}>↓</button>
            </div>
          )}

          <button type="button" className="text-button loc-delete" onClick={onDelete}>
            Delete this location
          </button>
          <p className="settings-note">
            Anything inside it moves up a level rather than being deleted
            with it.
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

/** Pictures of the place itself, as distinct from its map. */
function PictureField({ loc }: { loc: Loc }) {
  const generateUrl = useMutation(api.locations.generateUploadUrl);
  const addPicture = useMutation(api.locations.addPicture);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="detail-field">
      <div className="detail-label">Pictures</div>
      <div className="portrait-actions">
        <button
          type="button"
          className="npc-btn"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Uploading…" : "Add a picture"}
        </button>
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
