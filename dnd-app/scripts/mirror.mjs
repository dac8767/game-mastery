/**
 * Where Foundry's artwork lives once it is on the map server.
 *
 * ---------------------------------------------------------------------
 * Why there is a prefix at all
 *
 * Foundry's own paths are "icons/magic/..." and
 * "systems/dnd5e/tokens/...", and storing them unchanged looked right:
 * they are exactly what the export says. But the map server does not
 * serve the root of anything. Its Caddyfile routes two prefixes —
 *
 *   handle_path /web/*        -> /srv/web
 *   handle_path /originals/*  -> /srv/originals
 *
 * — and everything else falls through to a plain-text "Map server up."
 * response. So `${NEXT_PUBLIC_MAP_SERVER}/icons/magic/a.webp` returned
 * 200 with a sentence in it, the <img> failed to decode, and the
 * onError handler hid it. Seven thousand images, no error anywhere, no
 * pictures.
 *
 * Putting the mirror under `web/` makes it reachable through the route
 * that already exists, with the immutable cache header maps already get,
 * and needs no change to the running container. `foundry/` keeps it
 * beside `web/portraits/` and `web/maps/` rather than scattering
 * Foundry's two top-level directories through the same tree.
 *
 * ---------------------------------------------------------------------
 * One definition, three users
 *
 * import-foundry.mjs writes it into every row, fetch-foundry-images.mjs
 * writes the files under it, and the map server's Caddyfile has to route
 * its first segment. The integrity guard checks all three agree — the
 * bug above was three files each being individually reasonable.
 */
export const FOUNDRY_MIRROR = "web/foundry";
