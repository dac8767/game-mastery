"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { COLUMN_BY_KEY } from "@/components/npcColumns";
import { BODY_KEYS, resolveTemplate } from "@/components/NpcDetail";
import {
  NpcTemplate,
  SPANS,
  TEMPLATE_LIMITS,
  addTab,
  removeTab,
  renameTab,
  setSpan,
  shiftField,
  shiftTab,
  moveField,
  templateKeys,
} from "@/components/npcTemplate";

/**
 * Where the DM decides what an opened NPC looks like.
 *
 * Edited as a draft and saved in one go, not written per move. Dragging
 * a field between tabs is a dozen small decisions on the way to one
 * arrangement, and a mutation per step would be a dozen writes and a
 * dozen chances for someone else's record to jump while they read it.
 *
 * There is no "remove field" and no way to leave one unplaced. Every
 * column lives in exactly one tab, always — hiding a field is what the
 * record's own "show empty fields" switch is for, and a designer that
 * could drop a column would be a way to make a field unreachable for
 * the whole campaign without noticing.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTab, setNewTab] = useState("");

  if (stored === undefined) {
    return <p className="settings-note">Loading the layout…</p>;
  }

  // The draft, or what is stored, or the shipped arrangement — the same
  // resolution the record itself does, so the designer always shows
  // what an NPC would actually look like right now.
  const template = draft ?? resolveTemplate(stored ?? null);
  const dirty = draft !== null;

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
        The tabs and field order every NPC in this campaign opens with.
        Everyone sees the same layout — it is how the record reads, not a
        preference. Which fields a player actually receives is still decided
        on the server: a DM-only field placed on a shared tab stays hidden
        from them, and the tab renders without it.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="tpl-tabs">
        {template.tabs.map((tab, ti) => (
          <div className="tpl-tab" key={tab.id}>
            <header className="tpl-tab-head">
              <input
                className="detail-input tpl-tab-name"
                value={tab.title}
                maxLength={TEMPLATE_LIMITS.titleLength}
                aria-label="Tab name"
                onChange={(e) => edit(renameTab(template, tab.id, e.target.value))}
              />
              <button
                type="button"
                className="text-button"
                disabled={ti === 0}
                title="Move this tab left"
                onClick={() => edit(shiftTab(template, tab.id, -1))}
              >
                ←
              </button>
              <button
                type="button"
                className="text-button"
                disabled={ti === template.tabs.length - 1}
                title="Move this tab right"
                onClick={() => edit(shiftTab(template, tab.id, 1))}
              >
                →
              </button>
              <button
                type="button"
                className="text-button"
                disabled={template.tabs.length <= 1}
                title="Remove this tab — its fields move to the one beside it"
                onClick={() => edit(removeTab(template, tab.id))}
              >
                Remove
              </button>
            </header>

            {tab.fields.length === 0 ? (
              <p className="settings-note">
                Empty. Move a field here from another tab.
              </p>
            ) : (
              <ul className="tpl-fields">
                {tab.fields.map((f, fi) => {
                  const col = COLUMN_BY_KEY.get(f.key);
                  if (!col) return null;
                  return (
                    <li key={f.key}>
                      <span className="tpl-field-name">
                        {col.label}
                        {col.dmOnly && <span className="dm-tag">DM only</span>}
                      </span>

                      <select
                        aria-label={`Width of ${col.label}`}
                        value={f.span}
                        onChange={(e) =>
                          edit(setSpan(template, f.key, Number(e.target.value)))
                        }
                      >
                        {SPANS.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label={`Tab for ${col.label}`}
                        value={tab.id}
                        onChange={(e) =>
                          edit(
                            moveField(
                              template,
                              f.key,
                              e.target.value,
                              Number.MAX_SAFE_INTEGER
                            )
                          )
                        }
                      >
                        {template.tabs.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className="text-button"
                        disabled={fi === 0}
                        title="Move up"
                        onClick={() => edit(shiftField(template, f.key, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={fi === tab.fields.length - 1}
                        title="Move down"
                        onClick={() => edit(shiftField(template, f.key, 1))}
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
          value={newTab}
          placeholder="New tab name"
          maxLength={TEMPLATE_LIMITS.titleLength}
          aria-label="New tab name"
          onChange={(e) => setNewTab(e.target.value)}
        />
        <button
          type="button"
          className="npc-btn"
          disabled={
            !newTab.trim() || template.tabs.length >= TEMPLATE_LIMITS.tabs
          }
          onClick={() => {
            edit(addTab(template, newTab));
            setNewTab("");
          }}
        >
          Add tab
        </button>
        {template.tabs.length >= TEMPLATE_LIMITS.tabs && (
          <span className="settings-note">
            {TEMPLATE_LIMITS.tabs} tabs is the limit.
          </span>
        )}
      </div>

      {/* Every column, always, in exactly one tab. If this ever
          disagreed with the column list it would mean a field had gone
          missing from every record in the campaign. */}
      <p className="settings-note">
        {placed.length} of {BODY_KEYS.length} fields placed.
      </p>

      <div className="cal-actions">
        <button
          type="button"
          className="npc-btn"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            setError(null);
          }}
        >
          {dirty ? "Discard changes" : "No changes"}
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
