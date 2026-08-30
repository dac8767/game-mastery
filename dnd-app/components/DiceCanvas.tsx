"use client";

import { useEffect, useRef, useState } from "react";
import { backgroundUrl, toDddiceRoll } from "@/components/dddiceMap";
import { reason, statusOf } from "@/components/dddiceError";
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
 * keeps it in localStorage. The GM's own API key is never sent to a
 * player, never stored in Convex, and never in the repo. A leaked
 * guest key is a guest key.
 *
 * The SDK is imported dynamically for two reasons: it is a WebGL
 * renderer that must not be evaluated during a server render, and it
 * is far and away the heaviest thing in the app — a table that never
 * turns dddice on should not pay for it.
 */

/**
 * A theme the account actually OWNS.
 *
 * Every die needs a theme — it carries the mesh and the faces — and a
 * themeless die is refused. But so, in all likelihood, is a die
 * wearing a theme the roller does not own, which is why this does not
 * simply hand back the first slug in the public catalogue: that would
 * have swapped one 422 for another and looked like the same bug.
 *
 * So the catalogue is a place to SHOP, not a place to borrow from. A
 * theme found there is added to the dice box first, and the id that
 * comes back is one the account holds.
 *
 * Nothing is hard-coded. A slug copied out of a docs example is a slug
 * that stops existing without warning, and its failure is
 * indistinguishable from having no theme at all.
 */
async function ownedTheme(
  api: { diceBox: { list: () => Promise<unknown> } },
  key: string
): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const idOf = (payload: unknown): string | null => {
    const data = (payload as { data?: unknown } | undefined)?.data;
    const first = Array.isArray(data) ? data[0] : data;
    const id = (first as { id?: string } | undefined)?.id;
    return typeof id === "string" && id ? id : null;
  };

  // What the account already has.
  try {
    const mine = idOf(await api.diceBox.list());
    if (mine) return mine;
  } catch {
    // An unreadable dice box is not a reason to stop.
  }

  // Nothing owned yet: find one, then take it.
  try {
    const listed = await fetch("https://dddice.com/api/1.0/theme", { headers });
    if (!listed.ok) return null;
    const id = idOf(await listed.json());
    if (!id) return null;

    const added = await fetch("https://dddice.com/api/1.0/dice-box", {
      method: "POST",
      headers,
      body: JSON.stringify({ id }),
    });
    // The add is what makes it usable, so a refusal here is the answer
    // rather than something to roll past.
    if (!added.ok) {
      console.warn("[dice] could not add a theme to the dice box", added.status);
      return null;
    }
    return idOf(await added.json()) ?? id;
  } catch {
    return null;
  }
}

/**
 * Wait for the dice to stop moving, then say so.
 *
 * `roll()` resolves when the SERVER accepts the throw, which is well
 * before anything moves on screen — the animation starts when the room
 * broadcasts it back. So this waits for the dice to appear, then for
 * them to settle.
 *
 * Both waits are capped. A dropped websocket, a tab in the background
 * throttling its timers, an animation that never starts: every one of
 * them would otherwise leave a result withheld forever, and a roll you
 * never get to see is worse than one you see too early.
 */
function waitForDice(
  engineRef: { current: { readonly isDiceThrowing: boolean } | null },
  done: () => void
): void {
  const START_BY = 4000;
  const FINISH_BY = 12000;
  const TICK = 120;
  const began = Date.now();
  let started = false;

  const tick = () => {
    const engine = engineRef.current;
    if (!engine) return done();

    if (engine.isDiceThrowing) started = true;
    else if (started) return done();

    const waited = Date.now() - began;
    if (waited > FINISH_BY || (!started && waited > START_BY)) return done();
    window.setTimeout(tick, TICK);
  };
  window.setTimeout(tick, TICK);
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
  /**
   * Called when the thrown dice have stopped moving.
   *
   * The reason this exists: Convex answers in milliseconds and the
   * animation takes seconds, so the number was on screen well before
   * the dice landed. Knowing the result and then watching dice pretend
   * to decide it is worse than having no dice at all.
   */
  onSettled?: (rollId: string) => void;
  /** The theme's own rendered dice, for the tray. */
  onPreviews?: (previews: Record<string, string>) => void;
}

type Status = "off" | "connecting" | "ready" | "failed";

export function DiceCanvas({
  slug,
  passcode,
  theme,
  roll,
  onSettled,
  onPreviews,
}: DiceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // `unknown` rather than the SDK's type: importing the type eagerly
  // would pull the module into the server bundle it is dynamically
  // imported to stay out of.
  const engineRef = useRef<{
    roll: (dice: unknown[], options?: unknown) => Promise<unknown>;
    resize: (w: number, h: number) => unknown;
    stop: () => unknown;
    disconnect: () => unknown;
    readonly isDiceThrowing: boolean;
  } | null>(null);
  // Held in a ref so the throw effect does not re-run when the parent
  // hands down a new function identity — a re-run there re-throws the
  // dice.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const sentRef = useRef<string | null>(null);
  /**
   * A theme to use when the GM has not named one.
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
  /** The room's own artwork, which the renderer does not draw. */
  const [background, setBackground] = useState<string | null>(null);

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
        //
        // 409 means ALREADY a participant, which is the state this call
        // exists to reach. The guest account is kept in localStorage, so
        // every visit after the first one gets it — treating it as a
        // failure meant the integration worked exactly once and then
        // refused to start again, which is a worse bug than never
        // working, because it looks intermittent.
        step = `joining room ${slug}`;
        try {
          await engine.api.room.join(slug, passcode ?? undefined);
        } catch (e) {
          if (statusOf(e) !== 409) throw e;
        }
        if (cancelled) return;

        step = "connecting to the room";
        engine.connect(slug, passcode ?? undefined);
        engine.start();

        // The camera stays put.
        //
        // The engine ships with orbit controls on, which means the
        // scroll wheel flies the camera — and since this canvas is a
        // panel inside a page rather than dddice's own full-screen
        // room, a scroll aimed at the page zoomed straight past the
        // dice instead. There is no gesture here that should move a
        // camera, so there is no camera to move.
        engine.controlsEnabled = false;
        engine.resetCamera();

        if (cancelled) {
          engine.stop();
          engine.disconnect();
          return;
        }
        // The room's background image. The renderer does not draw it —
        // bgOpacity defaults to 0 and the artwork belongs to dddice's
        // own room page — so it is fetched and painted behind the
        // canvas here. Best-effort, like the theme below it.
        step = "reading the room";
        try {
          const room = await engine.api.room.get(slug, passcode ?? undefined);
          const path = (room as { data?: { bg_file_path?: string | null } })
            .data?.bg_file_path;
          if (!cancelled) setBackground(backgroundUrl(path));
        } catch {
          if (!cancelled) setBackground(null);
        }

        // A theme, from wherever one can be had.
        //
        // Every die needs one — it carries the mesh and the faces — and
        // a themeless die is refused with a 422, so "best effort" here
        // means trying more than one place. A fresh guest account can
        // have an EMPTY dice box, which is what made the first fallback
        // find nothing and send nothing.
        step = "finding a dice theme";
        fallbackThemeRef.current = await ownedTheme(engine.api, key);
        if (!fallbackThemeRef.current) {
          console.warn("[dice] no dddice theme found; rolls will be refused");
        }

        /**
         * The theme, fetched and LOADED before anything is thrown.
         *
         * This is the fix for a three-to-four second wait on the first
         * roll of a visit and none on any roll after it. A dddice theme
         * carries the meshes, the textures and the shaders for every
         * die in it, and the engine fetched all of that lazily — on the
         * first throw, while you watched. Every later roll reused it,
         * which is exactly why the delay looked like a fluke rather
         * than a load.
         *
         * The old comment here said the SDK had no preloading because
         * `preloadTheme` is newer than the version this app pins. That
         * was true and beside the point: the pinned version has
         * `loadTheme` and `loadThemeResources`, which are the same idea
         * under the names it uses. Looking for one spelling and
         * concluding the capability was absent is how the wait shipped.
         *
         * THE ORDER MATTERS, and only one way round works.
         * loadThemeResources opens with `if (this.themes[id] !== undefined)`
         * and does nothing at all otherwise — so called on its own it is
         * a silent no-op that looks exactly like a fix. loadTheme is
         * what registers the theme, and it also compiles the shader
         * material, which is the other thing the first throw was paying
         * for.
         *
         * The `true` is the default and is passed to say so. The two
         * `false`s are not: they turn off overwriting an already-loaded
         * theme, and turn off the engine's own preview fetches — this
         * response already carries the previews, and queueing a second
         * set of downloads during startup is the opposite of the point.
         *
         * It also replaces the raw preview fetch: this response IS the
         * theme, previews included, so the tray's dice come out of the
         * call that was needed anyway rather than a second one.
         */
        step = "loading the dice theme";
        const themeId = theme ?? fallbackThemeRef.current;
        if (themeId) {
          try {
            const full = (await engine.api.theme.get(themeId)).data;
            engine.loadTheme(full, false, false);
            engine.loadThemeResources(String(full.id), true);
            if (!cancelled && onPreviews && full.preview) {
              onPreviews(full.preview as Record<string, string>);
            }
          } catch (e) {
            // Best effort, like everything else on this canvas. Without
            // it the first roll is slow again; nothing breaks, and the
            // drawn icons stay as the tray's fallback.
            console.warn("[dice] could not preload the theme", e);
          }
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
        // WARN, not error. Next's dev overlay promotes console.error to
        // a full-screen blocking card, and this whole component is
        // decoration — a failure here changes no number on screen. A
        // red modal over the app is a wildly overstated way to say the
        // pretty dice are off.
        //
        // The whole error still goes to the console, where a stack is
        // useful; the step and dddice's own words go to the screen,
        // where they are the difference between "check the passcode"
        // and "wait a minute and reload".
        console.warn("[dice] dddice failed while " + step, e);
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
    // GM's choice falls back to whatever the account actually owns.
    const useTheme = theme ?? fallbackThemeRef.current ?? undefined;
    const dice = toDddiceRoll(roll.dice, useTheme);
    if (!dice) {
      // Too many dice for the room, or a die with no mesh. The log
      // already has the real answer; a partial throw would not.
      setNote("That pool is more than the dddice room will draw.");
      return;
    }
    setNote(null);
    const settled = () => settledRef.current?.(roll.id);
    void engineRef.current
      ?.roll(dice)
      .then(() => waitForDice(engineRef, settled))
      .catch((e: unknown) => {
      // Same rule as the connection: the console gets everything, the
      // screen gets dddice's own words. A bare "didn't take that roll"
      // is a dead end for whoever has to fix it.
      console.warn("[dice] dddice rejected the roll", {
        theme: useTheme ?? "(none)",
        sent: dice,
        // Pulled out by name: an axios error logs as a wall of config
        // and request objects, and the response body — the part that
        // says WHY — is buried several levels into it.
        body: (e as { response?: { data?: unknown } })?.response?.data,
        error: e,
      });
      setNote(`3D dice off — dddice rejected the roll: ${reason(e)}`);
      // A refused roll never animates, so nothing would ever release
      // the result that is waiting on it.
      settled();
    });
  }, [roll, status, theme]);

  if (!slug) return null;

  return (
    <div className="dice-canvas-wrap">
      {background && (
        <div
          className="dice-canvas-bg"
          style={{ backgroundImage: `url(${background})` }}
        />
      )}
      <canvas ref={canvasRef} className="dice-canvas" />
      {status === "connecting" && (
        <p className="dice-canvas-note">Waking the dice…</p>
      )}
      {note && <p className="dice-canvas-note">{note}</p>}
    </div>
  );
}
