# PRD — Sales Metrics Viewer (dashboard-heavy)

## Summary
A read-mostly metrics dashboard over a seeded sales-events dataset. Users
sign in and view aggregate sales performance by day, by category, and over a
selectable date range, with a small amount of manual event entry.

## Stack
Next.js, TypeScript, Tailwind CSS, shadcn/ui, one isolated Supabase Docker
stack. Email/password auth only. All routes require a signed-in session.

## Entities
- **Sale event**: date, category (text, e.g. "Electronics", "Apparel",
  "Home", "Grocery", "Other"), amount (decimal, > 0), quantity (integer, >
  0), created_by (FK to user).

## Seed data
On first run (or a seed script/button available to a signed-in user), seed
~90 days of synthetic sale events across the 5 categories with randomized
amounts/quantities, so the dashboard has data to show without manual entry.

## Features
1. **Auth**: sign up, sign in, sign out, protected app shell.
2. **Date-range filter**: a date-range picker (default: last 30 days) that
   re-scopes every view below.
3. **Totals view**: total revenue and total units sold for the selected
   range, broken down by day (a line or bar chart).
4. **Top-N breakdown**: top 5 categories by revenue for the selected range,
   shown as a chart (bar or pie) plus a table with revenue and unit totals
   per category.
5. **Manual event entry**: a form to add a single sale event (date, category,
   amount, quantity) that immediately reflects in the totals and breakdown
   once the range covers it.
6. **Event list**: a simple paginated/scrollable list of raw sale events in
   the selected range, most recent first.

## Out of scope
Multi-tenant orgs, exports, scheduled reports, forecasting, drill-down into
per-customer data, editing/deleting existing events.

## Acceptance sketch
- A signed-in user changes the date range and sees the totals chart, top-N
  breakdown, and event list all update to match.
- Adding a manual event inside the current range updates the totals and
  top-N breakdown without a full page reload being required to see it after
  a refresh.
- Signed-out access to any app route redirects to sign-in.
