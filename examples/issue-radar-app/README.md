# Issue Radar

Reference full-stack app for agent-foundry: a small issue tracker for teams of 3-20,
built exactly the way the `web-app-v1` generation pipeline would build it — Next.js App
Router, Tailwind v4, shadcn/ui, and a local Supabase stack for auth, Postgres, and
Storage. See `../issue-radar.prd.md` for the full product spec and
`../../docs/adr/0037-issue-radar-reference-app.md` for why this app is hand-authored
rather than live-generated.

## Golden journey

1. Sign up with an email and password (`/sign-up`) — no SMTP locally, so the session is
   active immediately.
2. Create a project from `/projects`.
3. Create an issue with a title (required, ≤140 chars), description, and priority.
4. Edit the issue, mark it complete (sets `completed_at`), reopen it (clears
   `completed_at`).
5. Filter the issue list by status and/or priority (combinable, via `?status=` /
   `?priority=` query params).
6. Watch the dashboard counts update immediately after any change.
7. Attach a PNG, JPEG, or PDF (≤10MB) to an issue and see it listed once processed.
8. Every table is row-level-security scoped to the signed-in user: a second account can
   never see, open, or edit the first account's projects, issues, or attachments.

This exact flow is what `apps/api/e2e/issue-radar-golden-journey.spec.ts` and
`apps/api/e2e/issue-radar-cross-user-access.spec.ts` assert against a real local
Supabase stack and a real `next dev` server.

## Running locally

```bash
npm install
npx supabase start          # boots local Postgres/Auth/Storage — needs Docker running
cp .env.example .env.local  # then fill in the values `supabase status --output json` prints
npm run dev                 # http://localhost:3000
```

## Exporting and deploying (Docker Compose)

This directory _is_ the export: it is a self-contained, git-tracked bundle of the app
code, every `supabase/migrations/*.sql` file, and a `Dockerfile` + `docker-compose.yml`.
To deploy it (per `../../docs/adr/0008-existing-vps-compose-deployment.md`):

```bash
# on the target host, with Docker and the Supabase CLI installed:
git clone <your fork/remote> && cd issue-radar-app
npx supabase start
npx supabase migration up   # applies every file in supabase/migrations/, forward-only
cp .env.example .env        # fill in NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
docker compose up --build -d
```

Put this behind Caddy (or another reverse proxy) for TLS, per ADR 0008. There is no
bundled Postgres/Supabase service in `docker-compose.yml` — this app expects its own
already-running local Supabase stack, one isolated Compose project per app, matching
every other generated project's deployment shape.

## Local attachment scanning

`packages/platform/src/supabase-storage.ts` (#72) makes `complete_storage_scan`
service-role-only by design, so a real deployment plugs in a real malware scanner.
Locally, `app/api/attachments/scan/route.ts` auto-approves every upload immediately
(`ponytail: trivial pass-through scanner, replace with a real scan service before
accepting untrusted multi-tenant uploads`).
