# ADR 0032: Secure generated-project storage

- Status: Accepted
- Date: 2026-07-23
- Owners: Platform, Core
- Extends: ADR 0031

## Context

Issue #69 gives each generated project its own Supabase CLI workdir, Compose project, network, and
database. A fixed bucket name is therefore still project-scoped; `uploads` in one generated stack is
not another project's bucket. Generated applications need private user uploads without turning the
browser into a storage administrator.

## Decision

Each generated project configures one private `uploads` bucket with native 10 MiB and
`image/png`, `image/jpeg`, and `application/pdf` MIME limits. Native bucket limits remain the last
enforcement point; metadata checks do not replace them. Ownership and clean-only download are enforced
by RLS on both `public.storage_uploads` and `storage.objects`.

The browser prepares metadata through `prepare_storage_upload`, then uses an authenticated signed upload
URL for `<user.id>/<opaque-name>`. It never receives a service-role key, S3 credential, or public URL.
Signed upload and download URLs are short-lived bearer credentials, so applications neither log nor
persist them.

New metadata starts in `quarantine`. `storage_scan_queue` and `complete_storage_scan` are
service-role-only: the scanner is a hook for an external scanner, not an antivirus implementation. A
reader can obtain bytes only when the owner record is `clean`. `rejected` and `quarantine` objects stay
unavailable.

`public.storage_uploads` records quarantine, retention, and export state. Generated applications and
operators treat the Storage schema as read-only: they do not mutate Storage-owned metadata or issue SQL
deletes against `storage.objects`. Export reads the clean manifest, copies bytes, and only then calls
`confirm_storage_export`. Cleanup selects `storage_cleanup_candidates`, deletes object bytes through the
Storage API, and only then calls `confirm_storage_cleanup`; the confirmation fails while bytes remain.

## Consequences

The generated runtime owns the bucket configuration and migration. An app must use the RPC and Storage
API sequence rather than direct metadata writes. The retention contract prevents cleanup of a clean object
until an explicit export confirmation exists; rejected expired objects need no export confirmation.

Rollback is forward-only. Disabling storage generation affects new projects only. Existing projects keep
their applied schema and must be rolled forward, or have it explicitly removed only after preserved
exported bytes make recovery possible. There is no automatic down migration or automatic restore.

## Validation and rollback

Unit tests pin native config, RLS, RPC grants, scan states, export, and cleanup predicates. The real local
Supabase E2E proves owner isolation, quarantine denial, native limits, signed clean reads, export, and
byte-before-metadata cleanup. Operational sequences and acceptance evidence are recorded in
`OPERATIONS.md`, `VALIDATION.md`, and `evidence/issue-72-secure-storage.md`.
