# PRD — Members Area (auth-heavy)

## Summary
A membership portal with two roles — admin and member — where access to each
section is gated by role, and per-role data access is enforced at the
database layer, not just hidden in the UI.

## Stack
Next.js, TypeScript, Tailwind CSS, shadcn/ui, one isolated Supabase Docker
stack. Email/password auth only.

## Entities
- **Profile**: user (FK, 1:1 with the auth user), display name, bio (free
  text), role (`admin` | `member`, default `member`).

## Roles and route matrix
- **Member**: can view and edit their own profile only. Cannot see the
  member directory or any other member's profile. Cannot change roles.
- **Admin**: can do everything a member can, plus: list all members (name,
  role, joined date), view any single member's profile, and change any
  member's role between `admin` and `member`.

Every route in the app requires a signed-in session. Role-gated routes
(member directory, member detail, role change) additionally require the
`admin` role — a signed-in `member` hitting one of these gets a clear
"not authorized" state, not a silent redirect to sign-in.

## RLS requirement
Row-level security on the profiles table (or equivalent) must enforce, at
the database layer:
- A member can `select`/`update` only their own profile row.
- An admin can `select` any profile row and `update` any profile's `role`
  column.
- These rules hold even for direct database access with a member's session —
  the app-layer route guard is not the only enforcement.

## Features
1. **Auth**: sign up (defaults to `member` role), sign in, sign out.
2. **Own profile**: view and edit own display name and bio.
3. **Member directory** (admin only): list all members with name, role,
   joined date.
4. **Member detail** (admin only): view any member's profile; change their
   role between `admin` and `member`.
5. Seed or provide a way to promote the first signed-up user to `admin` (a
   seed script, or an admin bootstrap step is acceptable) so the admin flows
   are reachable without manual database editing.

## Out of scope
More than two roles, invitations/email verification, granular
per-permission ACLs beyond the two roles, audit log of role changes.

## Acceptance sketch
- A member cannot reach the member directory or another member's profile
  through the UI, and a direct API/DB attempt to read another profile as
  that member is rejected by RLS, not just hidden by routing.
- An admin can list members, open a member's detail, and change their role;
  the change is reflected in that member's own session/profile view.
- Signed-out access to any app route redirects to sign-in.
