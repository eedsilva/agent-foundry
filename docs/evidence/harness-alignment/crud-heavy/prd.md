# PRD — Inventory Tracker (crud-heavy)

## Summary
A small internal inventory tracker for a single team. Users sign in and manage
stock items across categories, adjust quantities with a logged reason, and
find low-stock items fast.

## Stack
Next.js, TypeScript, Tailwind CSS, shadcn/ui, one isolated Supabase Docker
stack. Email/password auth only. All routes require a signed-in session.

## Entities
- **Category**: name, description.
- **Item**: name, SKU (unique), category (FK), quantity (integer, >= 0),
  reorder threshold (integer, >= 0).
- **Stock adjustment**: item (FK), delta (integer, positive = in, negative =
  out), reason (free text), created_at, created_by (FK to user).

## Features
1. **Auth**: sign up, sign in, sign out, protected app shell. No self-service
   password reset required.
2. **Categories**: list, create, edit, delete. Deleting a category with items
   attached is blocked with an inline error.
3. **Items**: list view with columns (name, SKU, category, quantity,
   threshold), filterable by category and by "low stock" (quantity <=
   threshold). Create, edit, delete a single item.
4. **Bulk edit**: select multiple items from the list and apply a quantity
   delta to all of them in one action, writing one stock adjustment row per
   item.
5. **Stock adjustment log**: adjusting an item's quantity (single or bulk)
   requires a reason and appends to the adjustment log. A per-item history
   view shows its adjustment log, most recent first.

## Out of scope
Multi-warehouse/location tracking, barcode scanning, supplier management,
purchase orders, CSV import/export, reporting/analytics.

## Acceptance sketch
- A signed-in user can create a category, create an item in it, adjust its
  quantity down below threshold, and see it appear in the low-stock filter.
- Bulk-editing 2+ items writes one adjustment row per item with the same
  reason.
- Signed-out access to any app route redirects to sign-in.
