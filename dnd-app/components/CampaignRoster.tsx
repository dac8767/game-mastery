"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/**
 * The party, as the DM knows it before anyone signs up.
 *
 * A campaign exists at a table long before it exists in an app, so the
 * roster is typed here rather than assembled out of accounts: a person's
 * name, the character they play, and a picture of it. Nothing here needs
 * the player to have registered.
 *
 * When registration arrives, a character with a `playerName` and no
 * `playerId` is exactly what a new account claims — which is why those
 * are two fields and not one. A claimed row keeps the same character,
 * the same portrait and the same history; it gains an owner.
 */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function CampaignRoster({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const characters = useQuery(api.campaigns.listCharacters, { campaignId });
  const upsert = useMutation(api.campaigns.upsertCharacter);
  const remove = useMutation(api.campaigns.deleteCharacter);

  const [playerName, setPlayerName] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A DM-run sheet has no player at all; the roster is the people at the
  // table, so those are listed under Tools rather than here.
  const party = (characters ?? []).filter(
    (c) => c.playerId || c.playerName
  );

  return (
    <section className="settings-block">
      <h2>Players and characters</h2>
      <p className="settings-note">
        Add everyone at your table by name — they don&apos;t need an account.
        When player sign-up arrives, each person claims the character already
        waiting for them, keeping its portrait and history.
      </p>

      {characters === undefined ? (
        <p className="settings-note">Loading the roster…</p>
      ) : (
        <ul className="roster">
          {party.map((c) => (
            <li key={c._id} className="roster-row">
              <RosterPortrait
                campaignId={campaignId}
                characterId={c._id}
                portraitUrl={c.portraitUrl}
                portraitPath={c.portraitPath ?? null}
                name={c.name}
              />
              <div className="roster-names">
                <input
                  className="roster-character"
                  defaultValue={c.name}
                  aria-label="Character name"
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (!next || next === c.name) return;
                    void upsert({
                      characterId: c._id,
                      campaignId,
                      name: next,
                      maxHp: c.maxHp,
                    });
                  }}
                />
                <input
                  className="roster-player"
                  defaultValue={c.playerName ?? ""}
                  placeholder="Player's name"
                  aria-label="Player name"
                  disabled={c.playerId !== undefined}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next === (c.playerName ?? "")) return;
                    void upsert({
                      characterId: c._id,
                      campaignId,
                      name: c.name,
                      maxHp: c.maxHp,
                      playerName: next || undefined,
                    });
                  }}
                />
              </div>
              <span className="roster-state">
                {c.playerId ? (
                  <span className="badge player">Claimed</span>
                ) : (
                  <span className="settings-note">Unclaimed</span>
                )}
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => void remove({ characterId: c._id })}
                title={`Remove ${c.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="roster-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          setError(null);
          try {
            await upsert({
              campaignId,
              name: name.trim(),
              playerName: playerName.trim() || undefined,
              // Every sheet needs one, and a real value belongs to the
              // player once they have a character to fill in.
              maxHp: 1,
            });
            setName("");
            setPlayerName("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not add them");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
          placeholder="Player's name"
          aria-label="New player name"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Character's name"
          aria-label="New character name"
        />
        <button type="submit" className="primary" disabled={!name.trim() || busy}>
          Add
        </button>
      </form>

      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

/** A character's picture, uploaded here and shown on the campaign card. */
function RosterPortrait({
  campaignId,
  characterId,
  portraitUrl,
  portraitPath,
  name,
}: {
  campaignId: Id<"campaigns">;
  characterId: Id<"characters">;
  portraitUrl: string | null;
  portraitPath: string | null;
  name: string;
}) {
  const generateUrl = useMutation(api.campaigns.generatePortraitUploadUrl);
  const setPortrait = useMutation(api.campaigns.setCharacterPortrait);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const src =
    portraitUrl ?? (portraitPath ? `${mapServer}/${portraitPath}` : null);

  return (
    <button
      type="button"
      className="roster-portrait"
      disabled={busy}
      title={src ? `Replace ${name}'s picture` : `Add a picture of ${name}`}
      onClick={() => input.current?.click()}
    >
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={src} alt="" loading="lazy" />
      ) : (
        <span className="roster-portrait-empty">{name.slice(0, 1)}</span>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file || file.size > MAX_IMAGE_BYTES) return;
          setBusy(true);
          try {
            const url = await generateUrl({ campaignId });
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": file.type },
              body: file,
            });
            if (!res.ok) throw new Error("upload failed");
            const { storageId } = (await res.json()) as { storageId: string };
            await setPortrait({
              characterId,
              storageId: storageId as Id<"_storage">,
            });
          } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
          }
        }}
      />
    </button>
  );
}
