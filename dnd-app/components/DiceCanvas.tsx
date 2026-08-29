"use client";

import { useEffect, useRef, useState } from "react";
import { toDddiceRoll } from "@/components/dddiceMap";
import type { DieRoll } from "@/components/diceModel";

/**
 * The 3D dice, on a canvas over the felt.
 *
 * dddice DRAWS the roll. It does not decide it. Every die is sent with
 * its face already set — their API supports exactly this for VTT
 * integrations — so Convex remains the only thing that says what was
 * rolled, and this canvas is decoration in the strict sense: remove it
 * and every number on screen is unchanged.
 *
 * That is also the failure model. Anything here that goes wrong — no
 * WebGL, no network, a room that will not accept us, a pool bigger
 * than the room's dice limit — leaves the 2D log exactly as it was.
 * There is no state in the app that depends on the canvas working, and
 * nothing here throws upward.
 *
 * Credentials: each browser mints its own dddice GUEST account and
 * keeps it in localStorage. The DM's own API key is never sent to a
 * player, never stored in Convex, and never in the repo. A leaked
 * guest key is a guest key.
 *
 * The SDK is imported dynamically for two reasons: it is a WebGL
 * renderer that must not be evaluated during a server render, and it
 * is far and away the heaviest thing in the app — a table that never
 * turns dddice on should not pay for it.
 */

/** Where a browser keeps the guest account it made for itself. */
const GUEST_KEY = "gm.dddice.guest";

/** How the app identifies itself to dddice. */
const APP_NAME = "Game Mastery";

export interface DiceCanvasProps {
  slug: string;
  passcode: string | null;
  theme: string | null;
  /**
   * The roll to draw, or null. Only ever the CALLER's own roll: the
   * room broadcasts it to everyone else, and a table where all six
   * browsers announce the same throw draws it six times.
   */
  roll: { id: string; dice: DieRoll[] } | null;
}

type Status = "off" | "connecting" | "ready" | "failed";

export function DiceCanvas({ slug, passcode, theme, roll }: DiceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // `unknown` rather than the SDK's type: importing the type eagerly
  // would pull the module into the server bundle it is dynamically
  // imported to stay out of.
  const engineRef = useRef<{
    roll: (dice: unknown[], options?: unknown) => Promise<unknown>;
    resize: (w: number, h: number) => unknown;
    stop: () => unknown;
    disconnect: () => unknown;
  } | null>(null);
  const sentRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>("off");
  const [note, setNote] = useState<string | null>(null);

  // ---- mount the engine once per room -----------------------------
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setStatus("connecting");
    setNote(null);

    (async () => {
      try {
        const sdk = await import("dddice-js");
        const { ThreeDDice, ThreeDDiceAPI } = sdk;

        if (!ThreeDDice.isWebGLAvailable()) {
          if (!cancelled) {
            setStatus("failed");
            setNote("This browser has no WebGL, so the 3D dice are off.");
          }
          return;
        }

        // A guest account per browser, made once and kept. Reading
        // localStorage can throw outright in a locked-down context, so
        // it is never the thing that stops the page.
        let key: string | null = null;
        try {
          key = window.localStorage.getItem(GUEST_KEY);
        } catch {
          key = null;
        }
        if (!key) {
          const api = new ThreeDDiceAPI(undefined, APP_NAME);
          key = (await api.user.guest()).data;
          try {
            window.localStorage.setItem(GUEST_KEY, key);
          } catch {
            // A private window rolls as a fresh guest every time. Fine.
          }
        }

        if (cancelled || !canvasRef.current) return;

        const engine = new ThreeDDice().initialize(
          canvasRef.current,
          key,
          {},
          APP_NAME
        );
        // Joining comes BEFORE connecting: the SDK throws when asked to
        // listen to a room the user is not a participant of.
        await engine.api?.room.join(slug, passcode ?? undefined);
        if (cancelled) return;

        engine.connect(slug, passcode ?? undefined);
        engine.start();
        // No preloading: `preloadTheme` is newer than the SDK version
        // this app pins, and each die carries its own `theme` anyway,
        // so the engine fetches what it needs on the first throw.

        if (cancelled) {
          engine.stop();
          engine.disconnect();
          return;
        }
        engineRef.current = engine as unknown as typeof engineRef.current;
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setStatus("failed");
        setNote(
          e instanceof Error && /passcode|403|401/i.test(e.message)
            ? "dddice refused that room — check the slug and passcode."
            : "Couldn't reach dddice. Rolls still work."
        );
      }
    })();

    return () => {
      cancelled = true;
      const engine = engineRef.current;
      engineRef.current = null;
      try {
        engine?.stop();
        engine?.disconnect();
      } catch {
        // Tearing down a half-built engine is not worth a crash.
      }
    };
  }, [slug, passcode, theme]);

  // ---- keep the canvas the size of its box ------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.parentElement;
    if (!box) return;

    const fit = () => {
      const { width, height } = box.getBoundingClientRect();
      if (width < 2 || height < 2) return;
      // The engine owns the backing store; without telling it, the
      // dice render into a stretched canvas at the old aspect ratio.
      engineRef.current?.resize(Math.round(width), Math.round(height));
    };

    const observer = new ResizeObserver(fit);
    observer.observe(box);
    fit();
    return () => observer.disconnect();
  }, [status]);

  // ---- draw the roll that just landed -----------------------------
  useEffect(() => {
    if (status !== "ready" || !roll) return;
    // Guarded by id: this effect re-runs on any render, and a re-sent
    // roll is the same dice thrown twice on everyone's table.
    if (sentRef.current === roll.id) return;
    sentRef.current = roll.id;

    const dice = toDddiceRoll(roll.dice, theme ?? undefined);
    if (!dice) {
      // Too many dice for the room, or a die with no mesh. The log
      // already has the real answer; a partial throw would not.
      setNote("That pool is more than the dddice room will draw.");
      return;
    }
    setNote(null);
    void engineRef.current?.roll(dice).catch(() => {
      setNote("dddice didn't take that roll. The result above stands.");
    });
  }, [roll, status, theme]);

  if (!slug) return null;

  return (
    <div className="dice-canvas-wrap">
      <canvas ref={canvasRef} className="dice-canvas" />
      {status === "connecting" && (
        <p className="dice-canvas-note">Waking the dice…</p>
      )}
      {note && <p className="dice-canvas-note">{note}</p>}
    </div>
  );
}
