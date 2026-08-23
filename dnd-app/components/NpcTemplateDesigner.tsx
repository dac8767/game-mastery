"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { COLUMN_BY_KEY } from "@/components/npcColumns";
import { BODY_KEYS, resolveTemplate } from "@/components/NpcDetail";
import { NpcTemplate, templateKeys } from "@/components/npcTemplate";
import {
  ResizeHandles,
  TabStripEditor,
  useTemplateEditing,
} from "@/components/RecordEditing";

/**
 * The NPC record layout, edited as the record.
 *
 * Not a list of field names with dropdowns beside them — that told you
 * what the layout contained and never what it looked like, so you
 * arranged it, saved, opened an NPC, and came back to move two things.
 * This IS the record: the same header, the same tab strip, the same
 * four-column grid, the same field controls, at the same sizes. Drag a
 * field to move it, drag its right edge to make it wider, drop it on a
 * tab to send it there.
 *
 * The fields are real controls rendered inert. A preview drawn out of
 * plain boxes would drift from the record the first time the record
 * changed, and the whole point is that what you arrange is what you
 * get.
 *
 * Drafted and saved in one go. Arranging is a dozen small decisions on
 * the way to one result, and a write per drag would be a dozen writes
 * and a dozen re-renders under the pointer.
 */

export function NpcTemplateDesigner({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const stored = useQuery(api.npcs.getTemplate, { campaignId });
  const save = useMutation(api.npcs.saveTemplate);
  const reset = useMutation(api.npcs.resetTemplate);

  const [draft, setDraft] = useState<NpcTemplate | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (stored === undefined) {
    return (
      <section className="settings-block">
        <p className="settings-note">Loading the layout…</p>
      </section>
    );
  }

  const template = draft ?? resolveTemplate(stored ?? null);
  const dirty = draft !== null;
  const editing = useTemplateEditing(template, (next) => {
    setDraft(next);
    setError(null);
  });
  const openTab =
    template.tabs.find((t) => t.id === tabId) ?? template.tabs[0] ?? null;

  const edit = (next: NpcTemplate) => {
    setDraft(next);
    setError(null);
  };

  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      setError(null);
      await save({ campaignId, tabs: draft.tabs });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the layout.");
    } finally {
      setBusy(false);
    }
  };

  const placed = templateKeys(template);

  return (
    <section className="settings-block">
      <h2>NPC record layout</h2>
      <p className="settings-note">
        This is the record itself. Drag a field to move it, drag its right
        edge to widen it, its bottom edge to make it taller, or the corner
        for both. Drop it on a tab to send it there. Everyone in this
        campaign opens an NPC to whatever you arrange here — which fields
        a player actually receives is still decided on the server, so a
        DM-only field on a shared tab stays hidden from them. The notes
        rail and the hide switch are fixed and are not arranged here.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="tpl-wys" {...editing.gridProps}>
        {/* The record's own top bar, inert. Drawn because leaving it out
            would put the tab strip at the top of the preview and an inch
            lower in the record. */}
        <div className="record-bar">
          <span className="npc-btn primary">Back to NPC List</span>
          <span className="npc-btn primary record-hide-btn">
            Hide Character from Players
          </span>
        </div>

        <div className="record-split">
        <section className="record-pane record-left">
          <header className="pane-head">
            <h2>NPC Info</h2>
          </header>
          <div className="pane-body">
          {/* The record's header, drawn as the record draws it, and in
              the same column — the notes run the full height beside it
              rather than starting underneath. Not arrangeable: the
              portrait and the name are what tell you whose record you
              are looking at. */}
          <div className="record-head tpl-head">
            <div className="record-portrait">
              <div className="portrait-empty">Portrait</div>
            </div>
            <div className="record-titles">
              <div className="detail-field record-title">
                <div className="detail-value">Name</div>
              </div>
              <div className="detail-field record-subtitle">
                <div className="detail-value">“Nickname”</div>
              </div>
              <p className="record-summary">
                <span className="record-chip">Job</span>
                <span className="record-chip">Species</span>
                <span className="record-chip">Place</span>
              </p>
            </div>
            <div className="record-head-right">
              <span className="settings-note tpl-head-note">
                Fixed — every record opens on its portrait and name.
              </span>
            </div>
          </div>

        <div className="record-tabbar">
          <TabStripEditor
            template={template}
            editing={editing}
            openTabId={openTab?.id ?? null}
            onChange={(next) => {
              setDraft(next);
              setError(null);
            }}
            onOpen={setTabId}
          />

          <span className="settings-note">
            {placed.length} of {BODY_KEYS.length} fields placed
          </span>
        </div>

        {/* The grid, at the record's own proportions. */}
        <div
          className="record-fields tpl-grid"
          ref={editing.gridRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (openTab) editing.dropField(openTab.id, Number.MAX_SAFE_INTEGER);
          }}
        >
          {openTab?.fields.map((f, fi) => {
            const col = COLUMN_BY_KEY.get(f.key);
            if (!col) return null;
            const span = editing.liveSpan(f.key, f.span);
            const rows = editing.liveRows(f.key, f.rows);
            const isDropTarget =
              editing.dropAt?.tab === openTab.id && editing.dropAt.index === fi;

            return (
              <div
                key={f.key}
                className={`detail-field tpl-field sp-${span}${
                  rows > 1 ? ` rw-${rows}` : ""
                }${col.dmOnly ? " dm-field" : ""}${
                  isDropTarget ? " over" : ""
                }`}
                {...editing.dragProps(f.key)}
                onDragOver={(e) => {
                  e.preventDefault();
                  editing.setDropAt({ tab: openTab.id, index: fi });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  editing.dropField(openTab.id, fi);
                }}
              >
                <div className="detail-label">
                  <span className="tpl-grip" aria-hidden="true">
                    ⠿
                  </span>
                  {col.label}
                  {col.dmOnly && <span className="dm-tag">DM only</span>}
                </div>

                {/* Inert copies of the record's own controls, so the
                    shape and height of a field here is the shape and
                    height it will have. */}
                {col.kind === "longtext" ? (
                  <textarea className="detail-input" rows={4} disabled />
                ) : col.kind === "boolean" ? (
                  <label className="detail-check">
                    <input type="checkbox" disabled />
                    <span>No</span>
                  </label>
                ) : (
                  <input
                    className="detail-input"
                    disabled
                    placeholder={
                      col.kind === "chips" ? "comma, separated" : ""
                    }
                  />
                )}

                <ResizeHandles
                  editing={editing}
                  fieldKey={f.key}
                  span={f.span}
                  rows={f.rows}
                />
                <span className="tpl-span">
                  {span}×{rows}
                </span>
              </div>
            );
          })}

          {openTab?.fields.length === 0 && (
            <p className="settings-note tpl-empty">
              Empty. Drag a field onto this tab’s name to move it here.
            </p>
          )}
        </div>
        </div>
        </section>

        {/* Drawn because it is half the record, and leaving it out
            would make the tabs look twice as wide here as they are. */}
        <aside className="record-notes tpl-notes">
          <div className="detail-field">
            <div className="detail-label">Player Notes</div>
            <textarea className="detail-input" rows={5} disabled />
          </div>
          <div className="detail-field dm-field">
            <div className="detail-label">
              DM Notes<span className="dm-tag">DM only</span>
            </div>
            <textarea className="detail-input" rows={5} disabled />
          </div>
          <p className="settings-note">
            Fixed — the notes are read beside every tab.
          </p>
        </aside>
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
          title="Go back to the layout the app ships with"
          onClick={async () => {
            setBusy(true);
            try {
              setError(null);
              await reset({ campaignId });
              setDraft(null);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not reset the layout."
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
          {busy ? "Saving…" : "Save layout"}
        </button>
      </div>
    </section>
  );
}
