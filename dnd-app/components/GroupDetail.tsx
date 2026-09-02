"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useUndoableMutation } from "@/components/useUndoable";
import { Id } from "@/convex/_generated/dataModel";

/**
 * One group, opened out of the list.
 *
 * The screen has a seam down the middle of it that is worth naming,
 * because everything here follows from it: the top half is the group's
 * OWN record — a name, a description, some pictures — and the bottom
 * half is the roll of who is in it, which is not stored here at all.
 * Membership is `npcs.groups`, typed on the NPC. So the roll is a list
 * of links out rather than a list you can edit, and the way to add
 * somebody to the Mining Guild is to open them and say so.
 *
 * A group with no record yet — a name some NPCs carry that nobody has
 * written up — opens here too, with everything but the roll empty. The
 * first thing you type creates the row. That is why every writing
 * action goes through `ensure()` rather than assuming an id: the id may
 * not exist until the moment you need it.
 */

export type GroupRow = {
  /** Unique per row — a group id, or the name key if it has none. */
  rowId: string;
  key: string;
  groupId: Id<"groups"> | null;
  name: string;
  description: string | null;
  attachments: { storageId: Id<"_storage">; url: string }[];
  members: string[];
  memberCount: number;
  described: boolean;
};

export function GroupDetail({
  group,
  campaignId,
  isDm,
  onOpenNpc,
  onBecameReal,
  onClose,
}: {
  group: GroupRow;
  campaignId: Id<"campaigns">;
  isDm: boolean;
  /** Send the reader to one of the members. */
  onOpenNpc: (name: string) => void;
  /**
   * This group had no document and now has one.
   *
   * Its identity moves with it — it was keyed by its name and is keyed
   * by its id from here on — and the list is holding the old key. Say
   * so, or the record closes itself the moment you type into it.
   */
  onBecameReal: (groupId: Id<"groups">) => void;
  onClose: () => void;
}) {
  const describeGroup = useMutation(api.groups.describeGroup);
  const updateGroup = useUndoableMutation(api.groups.updateGroup);
  const deleteGroup = useMutation(api.groups.deleteGroup);
  const generateUploadUrl = useMutation(api.groups.generateUploadUrl);
  const addAttachment = useMutation(api.groups.addAttachment);
  const removeAttachment = useMutation(api.groups.removeAttachment);

  const [description, setDescription] = useState(group.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Follows the row when the subscription redelivers it — including the
  // moment an undescribed group becomes a real one — but not while you
  // are mid-sentence in the box: `group.key` changes only when a
  // different group is opened.
  useEffect(() => {
    setDescription(group.description ?? "");
  }, [group.rowId, group.description]);

  /** The group's id, creating the row if this is its first edit. */
  const ensure = async (): Promise<Id<"groups">> => {
    if (group.groupId) return group.groupId;
    const groupId = await describeGroup({ campaignId, name: group.name });
    onBecameReal(groupId);
    return groupId;
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  };

  return (
    <section className="npc-record" aria-label={`${group.name} — full record`}>
      <div className="record-bar">
        <button
          type="button"
          className="npc-btn primary record-back"
          onClick={onClose}
        >
          Back to Groups
        </button>

        {/* GM only, and behind a confirmation — deleting a group takes
            its name off everybody in it, which is a change to the
            roster rather than to this screen. */}
        {isDm &&
          group.groupId &&
          (confirmDelete ? (
            <span className="record-confirm">
              <span className="settings-note">
                Delete this group, and take it off the {group.memberCount} NPC
                {group.memberCount === 1 ? "" : "s"} in it?
              </span>
              <button
                type="button"
                className="npc-btn"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </button>
              <button
                type="button"
                className="npc-btn danger"
                onClick={() =>
                  void run(async () => {
                    await deleteGroup({ groupId: group.groupId! });
                    onClose();
                  })
                }
              >
                Delete
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="npc-btn"
              onClick={() => setConfirmDelete(true)}
            >
              Delete group
            </button>
          ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="record-body group-record">
        <header className="record-head">
          <div className="record-titles">
            <GroupName
              value={group.name}
              editable={isDm}
              onCommit={(name) =>
                void run(async () => {
                  const groupId = await ensure();
                  return updateGroup(
                    { groupId, name },
                    { groupId, name: group.name },
                    `Name of ${group.name}`
                  );
                })
              }
            />
            {/* Said out loud, because an empty description on a group
                with members looks the same as a group that does not
                exist yet, and only one of those is worth doing
                anything about. */}
            {!group.described && (
              <p className="record-summary muted">
                Nobody has written this one up. It is a name
                {group.memberCount > 0
                  ? ` ${group.memberCount} NPC${group.memberCount === 1 ? "" : "s"} carry`
                  : ""}
                {isDm ? " — type below and it becomes a group." : "."}
              </p>
            )}
          </div>
        </header>

        <section className="group-block">
          <h3 className="group-h">Description</h3>
          {isDm ? (
            <textarea
              className="group-description"
              rows={6}
              value={description}
              placeholder="Who they are, what they want, who runs them."
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                const next = description.trim();
                if (next === (group.description ?? "").trim()) return;
                void run(async () => {
                  const groupId = await ensure();
                  return updateGroup(
                    {
                      groupId,
                      // null empties the field; "" would store a blank
                      // string and the column would stop reading as empty.
                      description: next === "" ? null : next,
                    },
                    { groupId, description: group.description ?? null },
                    `Description of ${group.name}`
                  );
                });
              }}
            />
          ) : (
            <p className={group.description ? "group-prose" : "muted"}>
              {group.description || "Nothing written down yet."}
            </p>
          )}
        </section>

        <section className="group-block">
          <h3 className="group-h">
            NPCs <span className="group-count">{group.memberCount}</span>
          </h3>
          {group.members.length === 0 ? (
            <p className="muted">
              Nobody is in this group. Open an NPC and add it to their Groups
              field — membership lives on the NPC.
            </p>
          ) : (
            <div className="cell-chips group-members">
              {group.members.map((name) => (
                <button
                  type="button"
                  className="chip chip-link"
                  key={name}
                  title="Open this NPC"
                  onClick={() => onOpenNpc(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="group-block">
          <h3 className="group-h">Attachments</h3>
          {group.attachments.length === 0 && !isDm && (
            <p className="muted">Nothing attached.</p>
          )}
          <div className="group-shots">
            {group.attachments.map((a) => (
              <span className="group-shot" key={a.storageId}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt="" />
                {isDm && group.groupId && (
                  <button
                    type="button"
                    className="group-shot-x"
                    aria-label="Remove this attachment"
                    title="Remove this attachment"
                    onClick={() =>
                      void run(() =>
                        removeAttachment({
                          groupId: group.groupId!,
                          storageId: a.storageId,
                        })
                      )
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>

          {isDm && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Cleared straight away so choosing the SAME file
                  // twice still fires a change event the second time.
                  e.target.value = "";
                  if (!file) return;
                  setUploading(true);
                  void run(async () => {
                    try {
                      const groupId = await ensure();
                      const url = await generateUploadUrl({ groupId });
                      const res = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": file.type },
                        body: file,
                      });
                      if (!res.ok) throw new Error("The upload failed.");
                      const { storageId } = (await res.json()) as {
                        storageId: Id<"_storage">;
                      };
                      await addAttachment({ groupId, storageId });
                    } finally {
                      setUploading(false);
                    }
                  });
                }}
              />
              <button
                type="button"
                className="npc-btn"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? "Uploading…" : "Add a picture"}
              </button>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

/**
 * The group's name, as a field rather than as a heading.
 *
 * A heading with the value baked into it is how a GM quietly loses the
 * ability to rename a thing from its own record — the NPC record was
 * written that way once and had to be undone. Saved on blur, and only
 * when it actually changed: renaming carries across every NPC that
 * carries the old name, so a save on every focus would rewrite the
 * roster for nothing.
 */
function GroupName({
  value,
  editable,
  onCommit,
}: {
  value: string;
  editable: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Follows the live query when the row redelivers — including the
  // moment an undescribed group becomes a real one.
  useEffect(() => setDraft(value), [value]);

  if (!editable) {
    return (
      <div className="detail-field record-title">
        <div className="detail-value">{value}</div>
      </div>
    );
  }

  return (
    <div className="detail-field record-title">
      <input
        className="detail-input"
        value={draft}
        placeholder="Name this group"
        aria-label="The group's name"
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next === "" || next === value.trim()) {
            setDraft(value);
            return;
          }
          onCommit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
