"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ALL_NAV_ITEMS,
  NAV_ITEM_BY_ID,
  SIDEBAR_GROUPS,
} from "@/components/navItems";
import {
  ALWAYS_VISIBLE,
  SIDEBAR_LIMITS,
  SidebarLayout,
  addSection,
  defaultSidebar,
  moveItem,
  reconcileSidebar,
  removeSection,
  renameSection,
  shiftItem,
  shiftSection,
  toggleHidden,
} from "@/components/sidebarLayout";

/**
 * Rearranging your own sidebar.
 *
 * Yours alone — the sidebar is a view of the app, not a fact about the
 * campaign, so this changes nothing for anyone else in the game.
 *
 * Drafted and saved in one go rather than written per move, for the
 * same reason as the NPC layout: arranging is a dozen small decisions
 * on the way to one result, and saving each would re-render the very
 * sidebar you are standing in.
 *
 * Nothing here can remove an item, only hide it. An item removed from
 * every section would be a screen with no way to reach it and no entry
 * anywhere saying it exists — and this designer, built from the same
 * layout, could not offer it back.
 */
export function SidebarDesigner() {
  const settings = useQuery(api.settings.mySettings);
  const save = useMutation(api.settings.saveMySettings);

  const [draft, setDraft] = useState<SidebarLayout | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSection, setNewSection] = useState("");

  if (settings === undefined) {
    return <p className="settings-note">Loading…</p>;
  }

  const layout =
    draft ??
    reconcileSidebar(
      settings.sidebar ?? defaultSidebar(SIDEBAR_GROUPS),
      ALL_NAV_ITEMS.map((i) => i.id)
    );
  const dirty = draft !== null;

  const edit = (next: SidebarLayout) => {
    setDraft(next);
    setError(null);
  };

  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setError(null);
      await save({ sidebar: draft });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the sidebar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-block">
      <h2>Side panel</h2>
      <p className="settings-note">
        Your own sidebar: hide what you do not use, group things your way,
        and put them in whatever order suits you. Nobody else sees any of
        it. Screens that are not built yet show greyed and cannot be
        opened; hiding one is a way to stop looking at it.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="tpl-tabs">
        {layout.sections.map((section, si) => (
          <div className="tpl-tab" key={section.id}>
            <header className="tpl-tab-head">
              <input
                className="detail-input tpl-tab-name"
                value={section.title}
                maxLength={SIDEBAR_LIMITS.titleLength}
                placeholder="No heading"
                aria-label="Section name"
                onChange={(e) =>
                  edit(renameSection(layout, section.id, e.target.value))
                }
              />
              <button
                type="button"
                className="text-button"
                disabled={si === 0}
                title="Move this section up"
                onClick={() => edit(shiftSection(layout, section.id, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="text-button"
                disabled={si === layout.sections.length - 1}
                title="Move this section down"
                onClick={() => edit(shiftSection(layout, section.id, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="text-button"
                disabled={layout.sections.length <= 1}
                title="Remove this section — its items move to the one beside it"
                onClick={() => edit(removeSection(layout, section.id))}
              >
                Remove
              </button>
            </header>

            {section.items.length === 0 ? (
              <p className="settings-note">
                Empty. Move something here from another section.
              </p>
            ) : (
              <ul className="tpl-fields">
                {section.items.map((item, ii) => {
                  const nav = NAV_ITEM_BY_ID.get(item.id);
                  if (!nav) return null;
                  const pinned = ALWAYS_VISIBLE.includes(item.id);
                  return (
                    <li key={item.id} className={item.hidden ? "off" : ""}>
                      <span className="tpl-field-name">
                        <span className="nav-icon">{nav.icon}</span>
                        {nav.label}
                        {nav.slug === undefined && (
                          <span className="soon">soon</span>
                        )}
                        {nav.dmOnly && <span className="badge">DM</span>}
                      </span>

                      <label className="detail-check">
                        <input
                          type="checkbox"
                          checked={!item.hidden}
                          disabled={pinned}
                          title={
                            pinned
                              ? "Settings cannot be hidden — it is the way back to this page"
                              : undefined
                          }
                          onChange={() => edit(toggleHidden(layout, item.id))}
                        />
                        <span>Show</span>
                      </label>

                      <select
                        aria-label={`Section for ${nav.label}`}
                        value={section.id}
                        onChange={(e) =>
                          edit(
                            moveItem(
                              layout,
                              item.id,
                              e.target.value,
                              Number.MAX_SAFE_INTEGER
                            )
                          )
                        }
                      >
                        {layout.sections.map((s, i) => (
                          <option key={s.id} value={s.id}>
                            {s.title || `Section ${i + 1}`}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className="text-button"
                        disabled={ii === 0}
                        title="Move up"
                        onClick={() => edit(shiftItem(layout, item.id, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={ii === section.items.length - 1}
                        title="Move down"
                        onClick={() => edit(shiftItem(layout, item.id, 1))}
                      >
                        ↓
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div className="tpl-add">
        <input
          className="detail-input"
          value={newSection}
          placeholder="New section name"
          maxLength={SIDEBAR_LIMITS.titleLength}
          aria-label="New section name"
          onChange={(e) => setNewSection(e.target.value)}
        />
        <button
          type="button"
          className="npc-btn"
          disabled={
            !newSection.trim() ||
            layout.sections.length >= SIDEBAR_LIMITS.sections
          }
          onClick={() => {
            edit(addSection(layout, newSection));
            setNewSection("");
          }}
        >
          Add section
        </button>
      </div>

      <div className="cal-actions">
        <button
          type="button"
          className="npc-btn"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(null);
            setError(null);
          }}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="npc-btn"
          disabled={busy}
          title="Go back to the sidebar the app ships with"
          onClick={async () => {
            setBusy(true);
            try {
              setError(null);
              await save({ sidebar: null });
              setDraft(null);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not reset the sidebar."
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Reset to default
        </button>
        <button
          type="button"
          className="npc-btn primary"
          disabled={!dirty || busy}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Save sidebar"}
        </button>
      </div>
    </section>
  );
}
