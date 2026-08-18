"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/**
 * Campaign chat.
 *
 * Visibility is the server's business — a dmOnly channel never appears
 * in a player's list, and asking for its messages by id returns the same
 * null as a channel that doesn't exist. Nothing here re-derives that.
 */

const VISIBILITY_LABEL: Record<string, string> = {
  everyone: "Everyone",
  dmOnly: "DM only",
  private: "Private",
};

export function ChatTool({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const campaigns = useQuery(api.campaigns.myCampaigns);
  const channels = useQuery(api.chat.listChannels, { campaignId });
  const [channelId, setChannelId] = useState<Id<"chatChannels"> | null>(null);

  const view = useQuery(
    api.chat.listMessages,
    channelId ? { channelId } : "skip"
  );

  const createChannel = useMutation(api.chat.createChannel);
  const deleteChannel = useMutation(api.chat.deleteChannel);
  const sendMessage = useMutation(api.chat.sendMessage);
  const deleteMessage = useMutation(api.chat.deleteMessage);

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const isDm = useMemo(
    () => campaigns?.find((c) => c._id === campaignId)?.isDm ?? false,
    [campaigns, campaignId]
  );

  // Select the first channel, and recover if the current one disappears.
  useEffect(() => {
    if (!channels) return;
    if (channelId && channels.some((c) => c._id === channelId)) return;
    setChannelId(channels[0]?._id ?? null);
  }, [channels, channelId]);

  // Follow the conversation as it arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [view?.messages.length, channelId]);

  async function run(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !channelId) return;
    setDraft("");
    await run(() => sendMessage({ channelId, body }));
  }

  if (channels === undefined) {
    return <p className="centered-note">Opening chat…</p>;
  }

  return (
    <div className="chat">
      <aside className="chat-channels">
        <div className="facet-label">Channels</div>
        <ul>
          {channels.map((c) => (
            <li key={c._id}>
              <button
                type="button"
                className={`chat-channel${
                  c._id === channelId ? " selected" : ""
                }`}
                onClick={() => setChannelId(c._id)}
              >
                <span className="hash">#</span>
                <span className="chat-channel-name">{c.name}</span>
                {c.visibility !== "everyone" && (
                  <span className="chip warn">
                    {VISIBILITY_LABEL[c.visibility]}
                  </span>
                )}
              </button>
            </li>
          ))}
          {channels.length === 0 && (
            <li className="nb-empty">
              {isDm ? "Make the first channel." : "No channels yet."}
            </li>
          )}
        </ul>

        {isDm && (
          <div className="chat-new">
            <button
              type="button"
              className="npc-btn"
              onClick={() => {
                const name = window.prompt("Channel name", "table-talk");
                if (name === null) return;
                const dmOnly = window.confirm(
                  "DM-only channel?\n\nOK = only you can see it.\nCancel = everyone in the campaign can."
                );
                void run(() =>
                  createChannel({
                    campaignId,
                    name,
                    visibility: dmOnly ? "dmOnly" : "everyone",
                  })
                );
              }}
            >
              + Channel
            </button>
            {channelId && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Delete this channel and every message in it?"
                    )
                  ) {
                    void run(() => deleteChannel({ channelId }));
                  }
                }}
              >
                Delete channel
              </button>
            )}
          </div>
        )}
      </aside>

      <section className="chat-main">
        {!channelId || !view ? (
          <p className="centered-note">
            {channels.length === 0
              ? "No channels yet."
              : "Pick a channel to start."}
          </p>
        ) : (
          <>
            <header className="chat-header">
              <span className="chat-title">
                <span className="hash">#</span>
                {view.channelName}
              </span>
              {view.visibility !== "everyone" && (
                <span className="chip warn">
                  {VISIBILITY_LABEL[view.visibility]}
                </span>
              )}
            </header>

            {error && <p className="form-error nb-error">{error}</p>}

            <div className="chat-log">
              {view.messages.length === 0 && (
                <p className="centered-note">Nothing here yet.</p>
              )}
              {view.messages.map((m) => (
                <article
                  key={m._id}
                  className={`chat-msg${m.isMine ? " mine" : ""}`}
                >
                  <div className="chat-msg-head">
                    <span className="chat-author">{m.authorName}</span>
                    <span className="chat-at">
                      {new Date(m.at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                    {m.canDelete && (
                      <button
                        type="button"
                        className="chat-del"
                        title="Delete"
                        onClick={() =>
                          void run(() => deleteMessage({ messageId: m._id }))
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <p className="chat-body">{m.body}</p>
                </article>
              ))}
              <div ref={endRef} />
            </div>

            <form className="chat-composer" onSubmit={send}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Message #${view.channelName}`}
                maxLength={4000}
              />
              <button type="submit" className="npc-btn primary">
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
