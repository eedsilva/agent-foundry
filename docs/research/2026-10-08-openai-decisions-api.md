# OpenAI Decisions API (`POST /v1/decisions`): research notes

Date: 2026-10-08. Sources: primary only (OpenAI docs, changelog, official SDK source, OpenAI community forum). If a claim appears only in third-party coverage, it is marked **unverified**.

Main references:

- Guide: <https://developers.openai.com/api/docs/guides/decisions>
- Changelog: <https://developers.openai.com/api/docs/changelog>
- Node SDK resource: <https://github.com/openai/openai-node/blob/master/src/resources/decisions.ts> (added in commit `7195644`, "feat(api): add standalone Decisions support (#2886)", 2026-10-06)
- Python SDK resource: <https://github.com/openai/openai-python/blob/main/src/openai/resources/decisions.py> (commit `b99e3e4`, #4033, 2026-10-06)

## Facts

| Topic | Finding | Source |
|---|---|---|
| Endpoint + auth | `POST https://api.openai.com/v1/decisions`, `Authorization: Bearer $OPENAI_API_KEY`, JSON body. The SDK marks it `bearerAuth`. | Guide; node `decisions.ts` |
| Request: `model` | Required string. Only `gpt-6-luna` is supported. | Guide |
| Request: `input` | Shared evidence: either a string or an array of `{role:"user", content}` messages. `content` is a string or a list of `input_text` / `input_image` parts. Not supported: non-user roles, function calls and outputs, files, audio, item references. | node `DecisionCreateParams` |
| Request: images | Must be base64 `data:` URLs. Hosted URLs and `file_id` are rejected. At most 128 image parts per request. Optional `detail`: `low`, `high`, `auto` or `original`. | Guide; node `DecisionInputImage` |
| Request: `questions[]` | Each question has a `type`, `instructions` and an optional `name`. The guide says names should be unique. Three types: `predicate` (no options); `choice` with `choices: [{value: string\|boolean, description?}]`; `score` with `levels: [{label, description?}]`, ordered low to high and 0-indexed. Independent questions can share one request. A decision that depends on another answer needs a second request. | Guide; node SDK |
| Request: other | Optional `safety_identifier` (opaque end-user id). There is **no** reasoning-effort or temperature parameter. | node SDK |
| Response | `{answers[], model, usage}`. Answers come back in question order. `predicate` returns `probability` (0..1). `choice` returns `choice`, `probabilities[{value, probability}]` and `confidence`. `score` returns `score` (a probability-weighted mean of level indices, which can fall between levels), `probabilities[{value, label, probability}]` and `confidence`. A question can instead return `{type:"refusal", name}`, and the refusal score is not disclosed. | Guide; node `Decision` |
| Reasoning text | None. The response has no rationale field. `usage.output_tokens_details.reasoning_tokens` exists in the schema, but no reasoning text is returned. | node `Decision.Usage` |
| Status | Beta. The changelog (Oct 6, 2026) says "Released the Decisions API in beta with `gpt-6-luna`". The guide says "public beta, and we expect to GA in the coming weeks". The community post "now available to all developers in public beta" is dated Oct 6, 2026, by user `sps`; that user shows no staff badge, so whether it is an official post is unverified. Third-party reports of an earlier limited preview at DevDay (Sep 29) and of a 403 feature gate on standard keys are **unverified**. | Changelog; guide; <https://community.openai.com/t/decisions-api-is-now-available-in-public-beta/1403877> |
| Pricing | $0.10 per 1M input tokens, input only. No charge for output, cache reads or cache writes. Regional-processing premiums and long-context input multipliers still apply. The general pricing page does not list Decisions yet. For comparison, `gpt-6-luna` on Responses costs $0.10 input / $0.50 output per 1M tokens, with a 2x input multiplier above 272K tokens. | Guide; <https://developers.openai.com/api/docs/models/gpt-6-luna> |
| Rate limits | No Decisions-specific limits are published. The `gpt-6-luna` model page lists 5k RPM / 2M TPM at the Build tier, but it does not list `/v1/decisions` as an endpoint, so whether those limits apply is **unknown**. | Model page; guide (silent) |
| Max questions / choices / levels | Not documented, apart from the 128-image cap. | Guide; SDK |
| Latency | Vendor claim: "about 10x faster than the Responses API", with no benchmark methodology. The "~150 ms vs 1.6 s" figure appears only in third-party coverage and is **unverified**. One community user reported about 0.8 s with image input (anecdotal). | Changelog; guide; forum thread |
| SDK support | Minimum versions with Decisions support: Python 3.26.0 (released 2026-10-06; 3.26.1 is current), Node 7.30.0 (2026-10-06; 7.30.1 is current), Go 3.73.0, Ruby 0.101.0, Java 4.78.0. Call it with `client.decisions.create(...)`. | Guide; GitHub releases of openai-node and openai-python |
| Data retention / ZDR | ZDR and HIPAA are available to eligible customers. Default abuse-monitoring logs are kept for up to 30 days. Data residency is offered in the US and EU (EEA + Switzerland); the EU option requires ZDR or a similar retention control. "Application state" is not covered by ZDR for this endpoint. Images flagged as CSAM are kept for review even under ZDR. | Guide; <https://developers.openai.com/api/docs/guides/your-data> |
| Known limitations | Only `gpt-6-luna` is supported. Images must be inline. Input must be user messages only, with no tools or files. Nothing is free-form: the API only picks or scores among options you supply. OpenAI says to calibrate thresholds against your own labeled examples and to add an "other" option. A user observed that `choice` overweights the most likely option (a 70% coin came back heads 98% of the time) while `predicate` stayed calibrated; this is anecdotal and **unverified**. The API reference page (`/api/reference/resources/decisions`) returns 404 today, so the SDK source is the de facto schema. | Guide; forum thread |

## Fit for Agent Foundry

Context: Agent Foundry runs locally. The orchestrator delegates coding subtasks to Codex CLI and Claude CLI subagents, and today authenticates only through the owner's CLI subscriptions. It uses no OpenAI API key.

**(a) Choosing provider, model and reasoning effort per subtask: good fit.** A single `choice` question over a fixed list (`codex/gpt-5.6-luna/medium`, `claude/sonnet/high`, and so on) answers exactly this question. The input is the subtask spec plus repo signals. `probabilities` and `confidence` make it auditable, and a low `confidence` result can fall back to a default. One request can carry several independent questions: provider, effort tier, and "needs browser/preview". Caveats:

- Choice confidence may be overconfident (anecdotal). Prefer one predicate per option, or calibrate thresholds on past runs.
- Quality depends on our option descriptions. Nothing has been benchmarked on our tasks.

**(b) Rubric scoring and pass/fail gates: plausible, as a cheap pre-filter.**

- `score` with ordered levels fits plan quality (e.g. "missing acceptance criteria" through "complete").
- Base64 screenshot input fits UI quality.
- `predicate` fits needs-human-approval, destructive-change and secrets-touched checks.

The outputs are probabilities, so a gate is just a threshold we choose. Do not let it be the sole authority on safety gates: for needs-human-approval, a high probability should *require* approval, but a low probability should never *bypass* a deterministic rule.

**(c) What it is not good for.** Open-ended design, writing plans or code, explaining *why* (it returns no rationale), multi-step reasoning where one decision feeds the next (each step needs its own call), and anything that needs tools or file access. The CLIs stay the workers; at most, Decisions is a router or judge in front of them.

**Cost and keys.** Adopting it adds an OpenAI API key and pay-per-token billing to a project that today runs only on subscriptions. That means a new secret to manage, a new failure mode (network, quota or beta changes), and data leaving the machine (relevant if users' repos are private; ZDR needs eligibility). The money is small: a 5K-token routing prompt costs about $0.0005. The real cost is the key and dependency footprint, not tokens.

**Deterministic fallback (required either way).**

- Routing: a static rule table keyed on subtask kind, file globs and size, with a fixed default provider and model.
- Gates: today's existing checks (tests, typecheck, explicit PRD approval per #602).

Decisions should be optional and off by default. Enable it only when `OPENAI_API_KEY` is set; log each answer next to the rule-table answer (shadow mode) before letting it override anything.

## Open questions

1. Does a standard key work today, or is there a feature gate (third-party 403 report)? Needs one live `curl` with the owner's key.
2. What are the rate limits for `/v1/decisions`, and are they shared with `gpt-6-luna` Responses quotas?
3. What are the maximum questions, choices and levels per request, and the input token cap?
4. Real latency distribution (p50/p95) for our prompt sizes, versus a Responses call or a plain rule table.
5. Calibration of `choice.confidence` versus `predicate` on our own labeled runs. Is the overconfidence anecdote real?
6. When is GA, and will the schema change? The API reference page currently 404s.
7. Can it be reached through the Codex CLI subscription auth path, or is it API-key only? Nothing found suggests subscription access.
8. Is it worth a key at all for v1? Per the project goal, v1 is the local loop only, so this is likely a post-v1 experiment.
