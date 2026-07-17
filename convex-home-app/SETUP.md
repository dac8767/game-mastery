# Home Coordination App — Convex + R2 Setup

## Stack

- **Next.js** on Vercel (free) — frontend
- **Convex** (free tier, never pauses) — database, realtime, auth, functions
- **Cloudflare R2** (free tier: 10 GB, zero egress fees) — images & attachments

## 1. Project setup

```bash
npx create-next-app@latest home-app
cd home-app
npm install convex @convex-dev/auth @convex-dev/r2 @auth/core
npx convex dev   # creates the Convex project, keeps schema synced
```

Copy the files from this scaffold's `convex/` directory into your project's
`convex/` directory. `npx convex dev` will push the schema and generate types.

## 2. Convex Auth

```bash
npx @convex-dev/auth   # one-time setup: generates keys, wires middleware
```

Create two accounts (you and your wife) through your sign-in page, then don't
expose a signup route in the UI. For belt-and-suspenders, add an email
allowlist inside the Password provider config in `convex/auth.ts`.

## 3. Cloudflare R2

1. Cloudflare dashboard → R2 → Create bucket (e.g. `home-app-files`)
2. Create an R2 API token with Object Read & Write scoped to that bucket
3. Add CORS rules on the bucket allowing PUT/GET from your app origins
   (localhost:3000 and your production domain)
4. Set the environment variables in Convex:

```bash
npx convex env set R2_BUCKET home-app-files
npx convex env set R2_ENDPOINT https://<account_id>.r2.cloudflarestorage.com
npx convex env set R2_ACCESS_KEY_ID <key>
npx convex env set R2_SECRET_ACCESS_KEY <secret>
```

## 4. Upload flow (client side)

1. `generateUploadUrl` → signed URL
2. `PUT` the file directly from the browser to R2
3. `syncMetadata` (component bookkeeping)
4. `registerAttachment` → creates the queryable metadata row

Bytes go browser → R2 directly; Convex only ever stores the key + metadata,
which is why 0.5 GB of database storage is a non-issue.

## 5. Deploy

```bash
npx convex deploy        # production Convex deployment
vercel                   # deploy Next.js; set NEXT_PUBLIC_CONVEX_URL env var
```

## Costs

| Service | Plan | Cost |
|---|---|---|
| Convex | Free (no pausing) | $0 |
| Cloudflare R2 | Free tier (10 GB) | $0 |
| Vercel | Hobby | $0 |
| Domain (optional) | — | ~$10–15/yr |

## Notes

- The `@convex-dev/r2` component API evolves; if a signature doesn't compile,
  check the README for your installed version:
  https://github.com/get-convex/r2
- Visibility pattern: `visibleTo` undefined = shared; set to a userId =
  private to that person. Filter in every query that lists user content.
- Keep reactive queries scoped (paginate long lists) to stay well inside
  Convex free-tier bandwidth.
