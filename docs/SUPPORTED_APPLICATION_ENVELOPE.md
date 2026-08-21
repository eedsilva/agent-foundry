# Supported Application Envelope v1

This specification defines the PRDs Personal Builder v1 may accept. Deterministic intake validation runs before Haiku. A requirement outside this envelope blocks approval and names the unsupported capability; Agent Foundry does not attempt it speculatively.

## Identity and access

- Supported application roles are signed-out user and authenticated Application Owner.
- Local signup, login, logout, protected routes, sessions, ownership, and cross-user denial are mandatory. A published Private Cloud Application has exactly one persistent Application Owner, disables public signup, and uses a disposable second identity only to prove cross-user denial.
- Public routes may contain informational and authentication UI only. Business records and application API operations require authentication.
- Runtime uses caller-scoped Supabase access only. Generated applications receive no service-role key.
- Cloud Owner Enrollment creates the sole confirmed cloud owner from a secure local prompt; public cloud signup and generated administrator credentials are unsupported.
- Sessions use one-hour access tokens with refresh until logout. Custom timeboxes, inactivity expiry, and single-session enforcement are unsupported.
- Application administrators, custom roles, organizations, teams, shared workspaces, invitations, and tenant membership are unsupported.
- Password reset is unsupported in v1.

## Data and behavior

- Maximum eight domain entities per PRD Revision. Join tables and platform-owned Auth metadata do not count.
- Supported relationships are explicit one-to-many and many-to-many relationships.
- Polymorphic, recursive, graph-shaped, organization-shared, and cross-tenant models are unsupported.
- Supported behavior is synchronous user-owned CRUD, filtering, sorting, pagination, and simple aggregate dashboard counts.
- Potentially unbounded lists use Backend API pagination with a default page size of 25 and maximum of 100.
- Physical deletion with explicit user confirmation is the default. A PRD may explicitly require archive or soft-delete behavior and its visibility rules.
- Create operations use an idempotency key scoped to Application Owner and normalized route for 24 hours. Same-key/same-content retries return the original outcome; same-key/different-content retries conflict. Expired records are cleaned opportunistically without a scheduled job.
- Updates reject a stale observed version instead of overwriting concurrent changes.
- Every domain entity records creation and update instants. A deletion instant exists only for an explicitly approved soft-delete lifecycle.
- Foreign keys default to restrictive deletion. Cascading deletion is permitted only for an exclusive child relationship named in the Schema Plan.
- The Schema Plan indexes foreign keys, ownership predicates, approved filters and sorts, and uniqueness constraints.
- One PRD Revision defines one interface language. Runtime language switching and translation catalogs are unsupported.

## Excluded capabilities

- Public business data or unauthenticated application APIs.
- Supabase Storage, file upload, media processing, or virus scanning.
- Supabase Realtime, presence, push updates, or collaboration.
- Cron, queues, long-running jobs, webhooks, or Supabase Edge Functions.
- Third-party application integrations, outbound email, SMS, payments, maps, analytics, or external identity providers.
- Mobile, desktop, extension, API-only, or non-web products.

## Technical boundaries

- Requests complete synchronously through the Web App and Hono Backend API.
- The browser never queries Supabase or the Backend API directly.
- Every domain table has ownership-aware RLS and cross-user denial evidence.
- Generated migrations grant required table and sequence privileges to `authenticated`, none for `anon` business data, and express update ownership with both `USING` and `WITH CHECK`.
- Database views are unsupported in v1; dashboards use caller-scoped Backend API operations.
- Every requirement uses the smallest fitting unit, integration, or browser proof.

## Evolution

Changing this envelope requires a versioned successor. An already approved PRD Revision remains bound to the envelope version recorded in its Generation Manifest.
