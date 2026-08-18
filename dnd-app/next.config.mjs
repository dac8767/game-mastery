import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app lives inside a larger repo; pin the workspace root so
  // Turbopack doesn't walk up and adopt the outer lockfile.
  turbopack: {
    root: import.meta.dirname,
  },
  // Map images come from the PowerEdge behind Cloudflare Access via plain
  // <img> tags (next/image optimization would proxy them through Vercel,
  // which both defeats the immutable-cache convention and can't pass the
  // player's Access cookie).
  env: {
    // Feedback submissions carry the app's version. Taken from
    // package.json at build time so it cannot drift from the release.
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
