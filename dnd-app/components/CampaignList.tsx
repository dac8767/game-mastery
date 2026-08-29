"use client";

import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  DateFormat,
  formatCardDate,
  untilSession,
} from "@/components/campaignCard";

/**
 * The front door: every campaign you are in, as a card you can read
 * before deciding which one to open.
 *
 * The card answers the questions you actually have standing at this
 * screen — when do we next play, who is running it, who is at the table
 * — rather than being a list of names that all look the same. All of it
 * is shaped server-side by campaigns.campaignCards; this file draws it.
 */

type Card = NonNullable<
  ReturnType<typeof useQuery<typeof api.campaigns.campaignCards>>
>[number];

export function CampaignList() {
  const cards = useQuery(api.campaigns.campaignCards);
  const settings = useQuery(api.settings.mySettings);
  const dateFormat: DateFormat = settings?.dateFormat ?? "dmy";
  const { signOut } = useAuthActions();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Card | null>(null);

  return (
    <div className="page">
      <header className="page-header">
        {/* A heading, not the app's name. The wordmark lives on the
            sign-in screen; here you are already in, and what this page
            needs to say is what the list below it is. */}
        <h1>
          <span className="page-title">Your Campaigns:</span>
        </h1>
        <div className="page-header-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => setCreating(true)}
          >
            New campaign
          </button>
          <button type="button" className="text-button" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {creating && <NewCampaign onDone={() => setCreating(false)} />}

      {cards === undefined ? (
        <p className="centered-note">Loading campaigns…</p>
      ) : cards.length === 0 ? (
        <p className="centered-note">
          You&apos;re not in a campaign yet. Start one above, or ask your DM to
          add you — they need the email you signed up with.
        </p>
      ) : (
        <ul className="campaign-list">
          {cards.map((card) => (
            <li key={card._id}>
              <CampaignCard
                card={card}
                dateFormat={dateFormat}
                onDelete={() => setDeleting(card)}
              />
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <DeleteCampaign card={deleting} onDone={() => setDeleting(null)} />
      )}
    </div>
  );
}

function CampaignCard({
  card,
  dateFormat,
  onDelete,
}: {
  card: Card;
  dateFormat: DateFormat;
  onDelete: () => void;
}) {
  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const image =
    card.imageUrl ?? (card.imagePath ? `${mapServer}/${card.imagePath}` : null);
  const soon = untilSession(card.nextSessionDate);

  return (
    <div className="campaign-card-wrap">
      <Link href={`/campaign/${card._id}`} className="campaign-card">
        {image ? (
          <span
            className="campaign-art"
            style={{ backgroundImage: `url(${image})` }}
          />
        ) : (
          <span className="campaign-art empty" aria-hidden="true" />
        )}

        <span className="campaign-body">
          <span className="name">
            {card.name}
            {card.isDm && <span className="badge">DM</span>}
            {card.viaAdmin && <span className="badge admin">Admin</span>}
          </span>

          {card.description && (
            <span className="description">{card.description}</span>
          )}

          <span className="campaign-facts">
            <span>
              <strong>DM</strong> {card.dmName}
            </span>
            {card.startDate && (
              <span>
                <strong>Started</strong> {formatCardDate(card.startDate, dateFormat)}
              </span>
            )}
            {card.nextSessionDate && (
              <span className={soon.overdue ? "overdue" : undefined}>
                <strong>Next session</strong>{" "}
                {formatCardDate(card.nextSessionDate, dateFormat)}
                {soon.label && <span className="campaign-soon"> {soon.label}</span>}
              </span>
            )}
          </span>

          {card.party.length > 0 && (
            <span className="campaign-party">
              {card.party.map((p) => {
                const art =
                  p.portraitUrl ??
                  (p.portraitPath ? `${mapServer}/${p.portraitPath}` : null);
                return (
                  <span
                    className="party-member"
                    key={p._id}
                    title={
                      p.playerName ? `${p.name} — ${p.playerName}` : p.name
                    }
                  >
                    {art ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        className="party-portrait"
                        src={art}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.visibility = "hidden";
                        }}
                      />
                    ) : (
                      <span className="party-portrait empty" aria-hidden="true">
                        {p.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="party-names">
                      <span className="party-character">{p.name}</span>
                      {p.playerName && (
                        <span className="party-player">{p.playerName}</span>
                      )}
                    </span>
                  </span>
                );
              })}
            </span>
          )}
        </span>
      </Link>

      {card.isDm && (
        <button
          type="button"
          className="campaign-delete"
          onClick={onDelete}
          title={`Delete ${card.name}`}
        >
          Delete
        </button>
      )}
    </div>
  );
}

function NewCampaign({ onDone }: { onDone: () => void }) {
  const create = useMutation(api.campaigns.createCampaign);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="campaign-new"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
          await create({
            name: name.trim(),
            description: description.trim() || undefined,
          });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not create it");
          setBusy(false);
        }
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Campaign name"
        aria-label="Campaign name"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="A line about it (optional)"
        aria-label="Description"
      />
      <button type="submit" className="primary" disabled={!name.trim() || busy}>
        {busy ? "Creating…" : "Create"}
      </button>
      <button type="button" className="text-button" onClick={onDone}>
        Cancel
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

/**
 * Deleting takes the notebook, the NPC roster, the locations and the
 * campaign's whole history with it, and there is no undo.
 *
 * So the confirmation is typing the name rather than clicking Yes: it
 * cannot be done by reflex, and it cannot be done to the wrong campaign
 * by accident, which a dialog with a button can be.
 */
function DeleteCampaign({ card, onDone }: { card: Card; onDone: () => void }) {
  const remove = useMutation(api.campaigns.deleteCampaign);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === card.name.trim();

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDone();
      }}
    >
      <div
        className="modal danger"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${card.name}`}
      >
        <h2>Delete {card.name}?</h2>
        <p>
          This deletes the campaign and everything in it — NPCs, locations,
          notebooks, the calendar, chat, encounters and every character sheet.
          It cannot be undone and there is no backup.
        </p>
        {card.party.length > 0 && (
          <p className="settings-note">
            {card.party.length}{" "}
            {card.party.length === 1 ? "character" : "characters"} on the roster
            will be deleted with it.
          </p>
        )}
        <label>
          Type <strong>{card.name}</strong> to confirm
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type the campaign name to confirm"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={!matches || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await remove({
                  campaignId: card._id as Id<"campaigns">,
                  confirmName: typed,
                });
                onDone();
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Could not delete it"
                );
                setBusy(false);
              }
            }}
          >
            {busy ? "Deleting…" : "Delete this campaign"}
          </button>
        </div>
      </div>
    </div>
  );
}
