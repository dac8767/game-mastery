"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

/**
 * What the campaign's card shows: its picture and its two dates.
 *
 * Campaign-wide and GM-only, like the rules edition beside it. The
 * fields save on blur rather than behind a Save button — there is no
 * partial state worth protecting here, and a Save button people forget
 * to press is a setting that silently did not happen.
 */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function CampaignDetails({
  campaignId,
}: {
  campaignId: Id<"campaigns">;
}) {
  const cards = useQuery(api.campaigns.campaignCards);
  const update = useMutation(api.campaigns.updateCampaign);
  const generateUrl = useMutation(api.campaigns.generateImageUploadUrl);
  const setImage = useMutation(api.campaigns.setCampaignImage);

  const card = cards?.find((c) => c._id === campaignId);

  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local copies so typing is not fighting the server round-trip, seeded
  // once the card arrives.
  const [start, setStart] = useState("");
  const [next, setNext] = useState("");
  const seeded = useRef(false);

  useEffect(() => {
    if (!card || seeded.current) return;
    setStart(card.startDate ?? "");
    setNext(card.nextSessionDate ?? "");
    seeded.current = true;
  }, [card]);

  if (!card) return null;

  const mapServer = process.env.NEXT_PUBLIC_MAP_SERVER ?? "";
  const image =
    card.imageUrl ?? (card.imagePath ? `${mapServer}/${card.imagePath}` : null);

  async function upload(file: File) {
    if (file.size > MAX_IMAGE_BYTES) {
      setError("That image is over 12MB — shrink it first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = await generateUrl({ campaignId });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { storageId } = (await res.json()) as { storageId: string };
      await setImage({
        campaignId,
        storageId: storageId as Id<"_storage">,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="settings-block">
      <h2>Campaign card</h2>
      <p className="settings-note">
        What everyone sees on the screen where they pick a campaign.
      </p>

      <div className="campaign-details">
        <div className="campaign-image-field">
          {image ? (
            <span
              className="campaign-art"
              style={{ backgroundImage: `url(${image})` }}
            />
          ) : (
            <span className="campaign-art empty" aria-hidden="true" />
          )}
          <div className="campaign-image-actions">
            <input
              ref={input}
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            {card.imageUrl && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void setImage({ campaignId, storageId: null })}
              >
                Remove picture
              </button>
            )}
          </div>
        </div>

        <label className="settings-field">
          <span>Campaign started</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onBlur={() => void update({ campaignId, startDate: start })}
          />
        </label>

        <label className="settings-field">
          <span>Next session</span>
          <input
            type="date"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            onBlur={() => void update({ campaignId, nextSessionDate: next })}
          />
        </label>
      </div>

      <p className="settings-note">
        Both are real-world dates — when you first played and when you next
        will. The campaign&apos;s own calendar, with its invented months, lives
        under Tools and has nothing to do with these.
      </p>

      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
