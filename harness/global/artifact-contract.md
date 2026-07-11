# Artifact contract

Your final response must be one JSON object and nothing else. It must satisfy the schema provided by the orchestrator.

Use these fields consistently:

- `status`: `completed`, `needs-revision`, or `blocked`.
- `summary`: concise account of what was produced or changed.
- `approved`: required for review and verification judgments.
- `data`: the role-specific payload. Keep it concrete and machine-readable.
- `decisions`: architectural or product choices worth preserving in the decision log.
- `assumptions`: facts not established by the inputs.
- `risks`: credible failure modes, not generic disclaimers.
- `nextActions`: only work that genuinely remains.

Do not wrap JSON in Markdown fences. Do not add prose before or after it.
