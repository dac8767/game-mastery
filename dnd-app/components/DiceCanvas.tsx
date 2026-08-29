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

/**
 * Whatever the thing that failed had to say for itself.
 *
 * dddice's errors are not all Error instances — the SDK throws its own
 * APIError types and axios-shaped rejections — and `String(e)` on one
 * of those is "[object Object]", which is how a diagnosable failure
 * turns into an unactionable one.
 */
function reason(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const any = e as Record<string, unknown>;
    const response = any.response as { status?: number } | undefined;
    const status = typeof any.status === "number" ? any.status : response?.status;
    const message =
      typeof any.message === "string" && any.message ? any.message : null;
    if (status && message) return `${message} (HTTP ${status})`;
    if (status) return `HTTP ${status}`;
    if (message) return message;
  }
  return "no reason given — see the browser console";
}

/** Where a browser keeps the guest account it made for itself. */
const GUEST_KEY = "gm.dddice.guest";

/**
 * The SDK's `appName` is deliberately NOT set.
 *
 * It is cosmetic — it identifies the integration in dddice's logs —
 * but the SDK turns it into an `X-Extension` request header, and a
 * custom header on a cross-origin XHR forces a CORS preflight that
 * dddice must then be willing to answer. Their own integrations are
 * browser extensions, which are not subject to CORS at all, so that
 * path is far better travelled than ours.
 *
 * This is a hedge, not a diagnosis: it removes a known way for a
 * cross-origin call to fail, in exchange for a field nothing reads.
 */

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
  /**
   * A theme to use when the DM has not named one.
   *
   * Every die needs a theme: it is what carries the mesh and the face
   * values, so a die without one has nothing to draw. Read out of the
   * account's own dice box rather than hard-coded, because a theme
   * slug guessed from a docs example is a slug that stops existing
   * without warning.
   */
  const fallbackThemeRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>("off");
  const [note, setNote] = useState<string | null>(null);

  // ---- mount the engine once per room -----------------------------
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setStatus("connecting");
    setNote(null);

    // Which step we are on, so a failure names the step. The first
    // version reported every failure as "Couldn't reach dddice",
    // which is the same sentence for a missing WebGL context, a
    // rate-limited guest signup and a wrong passcode — three
    // different fixes behind one message, and no way to tell them
    // apart without reading the code.
    let step = "loading the dddice library";

    (async () => {
      try {
        const sdk = await import("dddice-js");
        const { ThreeDDice, ThreeDDiceAPI } = sdk;

        step = "checking WebGL";
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
          // dddice rate-limits guest signup to 3 per minute per IP, so
          // this is a step that legitimately fails and recovers.
          step = "creating a dddice guest account";
          const api = new ThreeDDiceAPI();
          key = (await api.user.guest()).data;
          try {
            window.localStorage.setItem(GUEST_KEY, key);
          } catch {
            // A private window rolls as a fresh guest every time. Fine.
          }
        }

        if (cancelled || !canvasRef.current) return;

        step = "starting the renderer";
        const engine = new ThreeDDice().initialize(canvasRef.current, key, {});
        // initialize() builds the API client, so this is a real
        // failure rather than something to optional-chain past —
        // skipping the join silently would surface later as an
        // unexplained "not a participant" from connect().
        if (!engine.api) throw new Error("the dddice client did not start");

        // Joining comes BEFORE connecting: the SDK throws when asked to
        // listen to a room the user is not a participant of.
        step = `joining room ${slug}`;
        await engine.api.room.join(slug, passcode ?? undefined);
        if (cancelled) return;

        step = "connecting to the room";
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
        // Best-effort: no theme is a worse throw, not a broken one, so
        // this must not be able to fail the whole connection.
        step = "reading the dice box";
        try {
          const box = await engine.api.diceBox.list();
          const themes = (box as { data?: { id?: string }[] }).data;
          fallbackThemeRef.current = themes?.[0]?.id ?? null;
        } catch {
          fallbackThemeRef.current = null;
        }
        if (cancelled) {
          engine.stop();
          engine.disconnect();
          return;
        }

        engineRef.current = engine as unknown as typeof engineRef.current;
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        // The whole error to the console, where a stack is useful; the
        // step and dddice's own words to the screen, where they are
        // the difference between "check the passcode" and "wait a
        // minute and reload".
        console.error("[dice] dddice failed while " + step, e);
        setStatus("failed");
        setNote(`3D dice off — failed while ${step}: ${reason(e)}`);
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

    // A die with no theme has no mesh and nothing to draw, so the
    // DM's choice falls back to whatever the account actually owns.
    const useTheme = theme ?? fallbackThemeRef.current ?? undefined;
    const dice = toDddiceRoll(roll.dice, useTheme);
    if (!dice) {
      // Too many dice for the room, or a die with no mesh. The log
      // already has the real answer; a partial throw would not.
      setNote("That pool is more than the dddice room will draw.");
      return;
    }
    setNote(null);
    void engineRef.current?.roll(dice).catch((e: unknown) => {
      // Same rule as the connection: the console gets everything, the
      // screen gets dddice's own words. A bare "didn't take that roll"
      // is a dead end for whoever has to fix it.
      console.error("[dice] dddice rejected the roll", { dice, error: e });
      setNote(`3D dice off — dddice rejected the roll: ${reason(e)}`);
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
