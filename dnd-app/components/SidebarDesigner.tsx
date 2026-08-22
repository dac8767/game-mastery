"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ALL_NAV_ITEMS,
  NAV_ITEM_BY_ID,
  SIDEBAR_GROUPS,
} from "@/components/navItems";
import {
  SIDEBAR_LIMITS,
  SidebarLayout,
  addSection,
  defaultSidebar,
  hiddenItems,
  hideAll,
  moveItem,
  reconcileSidebar,
  removeSection,
  renameSection,
  setHidden,
  shiftSection,
  showAll,
  shownItems,
} from "@/components/sidebarLayout";

/**
 * Rearranging your own sidebar, by dragging.
 *
 * Yours alone — the sidebar is a view of the app, not a fact about the
 * campaign, so this changes nothing for anyone else in the game.
 *
 * Dragging replaced a pair of arrows and a section dropdown. Those
 * worked, and described the layout rather than being it: moving one
 * item down two places and across a section was four clicks in three
 * different controls, and none of them looked like where the thing
 * would end up. A drop into Hidden hides; a drop back into a section
 * shows. The gesture IS the instruction, so there is nothing else to
 * keep in step with it.
 *
 * Drafted and saved in one go rather than written per move: arranging
 * is a dozen small decisions on the way to one result, and saving each
 * would re-render the very sidebar you are standing in.
 *
 * Nothing here can remove an item, only hide it. An item in no section
 * would be a screen with no way to reach it and no entry anywhere
 * saying it exists — and this designer, built from the same layout,
 * could not offer it back.
 */
export function SidebarDesigner() {
  const settings = useQuery(api.settings.mySettings);
  const save = useMutation(api.settings.saveMySettings);

  const [draft, setDraft] = useState<SidebarLayout | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSection, setNewSection] = useState("");

  /** What is being dragged, and where the pointer last suggested. */
  const dragging = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<{
    section: string;
    index: number;
  } | null>(null);

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
  const hidden = hiddenItems(layout);

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

  /** Dropped into a section: it lands there, and it is shown. */
  const dropInSection = (sectionId: string, index: number) => {
    const id = dragging.current;
    dragging.current = null;
    setDropAt(null);
    if (!id) return;
    edit(setHidden(moveItem(layout, id, sectionId, index), id, false));
  };

  /** Dropped into Hidden: it stays where it is filed, switched off. */
  const dropInHidden = () => {
    const id = dragging.current;
    dragging.current = null;
    setDropAt(null);
    if (!id) return;
    edit(setHidden(layout, id, true));
  };

  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragging.current = id;
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag with no payload.
      e.dataTransfer.setData("text/plain", id);
    },
    onDragEnd: () => {
      dragging.current = null;
      setDropAt(null);
    },
  });

  return (
    <section className="settings-block">
      <h2>Side panel</h2>
      <p className="settings-note">
        Your own sidebar. Drag anything into the order you want it, into
        another section, or into Hidden to switch it off — and back out
        again to bring it round. Nobody else sees any of it. Nothing is
        ever removed, because a screen with no way to reach it is worse
        than one you scroll past.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="sbd-columns">
        <div className="sbd-col">
          <header className="sbd-col-head">
            <h3>Shown</h3>
            <button
              type="button"
              className="text-button"
              onClick={() => edit(hideAll(layout))}
            >
              Hide all
            </button>
          </header>

          <div className="tpl-tabs">
            {layout.sections.map((section, si) => {
              const items = shownItems(section);
              return (
                <div
                  className="tpl-tab"
                  key={section.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropAt({ section: section.id, index: items.length });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropInSection(section.id, Number.MAX_SAFE_INTEGER);
                  }}
                >
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

                  {items.length === 0 ? (
                    <p className="settings-note sbd-drop-hint">
                      Empty — drop something here.
                    </p>
                  ) : (
                    <ul className="tpl-fields">
                      {items.map((item, ii) => {
                        const nav = NAV_ITEM_BY_ID.get(item.id);
                        if (!nav) return null;
                        const over =
                          dropAt?.section === section.id &&
                          dropAt.index === ii;
                        return (
                          <li
                            key={item.id}
                            className={`sbd-row${over ? " over" : ""}`}
                            {...dragProps(item.id)}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDropAt({ section: section.id, index: ii });
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              dropInSection(section.id, ii);
                            }}
                          >
                            <span className="tpl-field-name">
                              <span className="tpl-grip" aria-hidden="true">
                                ⠿
                              </span>
                              <span className="nav-icon">{nav.icon}</span>
                              {nav.label}
                              {nav.slug === undefined && (
                                <span className="soon">soon</span>
                              )}
                              {nav.dmOnly && <span className="badge">DM</span>}
                            </span>
                            <button
                              type="button"
                              className="text-button"
                              title="Move this to Hidden"
                              onClick={() =>
                                edit(setHidden(layout, item.id, true))
                              }
                            >
                              Hide
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
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
        </div>

        {/* Everything switched off, flat. Which section a hidden thing
            is filed under is not a question anyone has — it is off, and
            the only thing you want to do with it is put it back. It
            keeps its filing, so dragging it out returns it there. */}
        <div
          className="sbd-col sbd-hidden-col"
          onDragOver={(e) => {
            e.preventDefault();
            setDropAt({ section: "__hidden", index: 0 });
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropInHidden();
          }}
        >
          <header className="sbd-col-head">
            <h3>Hidden</h3>
            <button
              type="button"
              className="text-button"
              disabled={hidden.length === 0}
              onClick={() => edit(showAll(layout))}
            >
              Show all
            </button>
          </header>

          {hidden.length === 0 ? (
            <p className="settings-note sbd-drop-hint">
              Nothing hidden. Drop something here to switch it off.
            </p>
          ) : (
            <ul className="tpl-fields sbd-hidden">
              {hidden.map((item) => {
                const nav = NAV_ITEM_BY_ID.get(item.id);
                if (!nav) return null;
                return (
                  <li
                    key={item.id}
                    className="sbd-row"
                    {...dragProps(item.id)}
                  >
                    <span className="tpl-field-name">
                      <span className="tpl-grip" aria-hidden="true">
                        ⠿
                      </span>
                      <span className="nav-icon">{nav.icon}</span>
                      {nav.label}
                      {nav.slug === undefined && (
                        <span className="soon">soon</span>
                      )}
                      {nav.dmOnly && <span className="badge">DM</span>}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      title="Put this back in the sidebar"
                      onClick={() => edit(setHidden(layout, item.id, false))}
                    >
                      Show
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
