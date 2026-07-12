# Project automations

Open **Agent Foundry Delivery → Workflows** and configure:

1. Auto-add issues and pull requests from `eedsilva/agent-foundry`.
2. Newly added items start in `Inbox`.
3. Pull request opened for a linked issue moves it to `In Review`.
4. Pull request merged moves the linked issue to `Done`.
5. Reopened issue moves to `Ready`.
6. Auto-archive `Done` items after 30 days.

Do not create an automation that resets `Status`, `Size`, `Confidence`, or `Evidence` during spec reconciliation. Those are operational fields owned by humans and delivery evidence.

The `In Progress` WIP limit is two. The Project UI does not enforce this as a transaction, so the `Now` view must make violations obvious and weekly review must correct them.
