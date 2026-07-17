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
};

export default nextConfig;
