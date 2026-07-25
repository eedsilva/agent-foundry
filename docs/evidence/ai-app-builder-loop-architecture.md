# How production AI app builders architect their agent loop — evidence

**Research date:** 2026-07-25
**Question that prompted it:** Agent Foundry runs a 7-node waterfall (`workflows/web-app-v1.yaml`) whose first three nodes
are `quality-loop`s — setup agent → LLM reviewer agent → LLM repair agent, `maxIterations: 3` — all producing prose before
any code exists. One observed run cost **$2.91 / 13 min and produced zero lines of code**. Do the incumbents actually work
this way?

**Bottom line.** Partly, and the difference is precise. A distinct planning step with a **human approval gate** is real and
near-universal (Lovable's Plan mode writing `.lovable/plan.md`, Replit's task board, v0's `exit_plan_mode`, bolt's Plan/
Discuss mode). What does **not** exist in any primary source is an *LLM reviewer agent grading another agent's prose as a
blocking gate*: the approver is always a human, and the repair signal is always a **real execution failure** — non-zero
shell exit, a forwarded browser exception, a failed Playwright interaction, a failed build. Where a second model exists it
is a post-processor (v0's `vercel-autofixer-01`), a context-isolated tester (Replit), or an explicitly read-only advisor
(Lovable subagents) — never a gate. Everything is optimised to reach a **running preview within minutes** and derive work
from its failures; the scaffold is fixed, immediately runnable, and stack choice is either absent or explicitly degraded.

---

## Source quality and caveats

| Source | Type | Trust | Date |
| --- | --- | --- | --- |
| [bolt.diy source](https://github.com/stackblitz-labs/bolt.diy) @ [`2e254ac`](https://github.com/stackblitz-labs/bolt.diy/commit/2e254ac19a696394030601bc602f54945b12bfc4) | Running source code | Highest | HEAD commit 2026-02-07 |
| [support.bolt.new](https://support.bolt.new/llms.txt) | Official StackBlitz product docs | High | live, fetched 2026-07-25 |
| [docs.lovable.dev](https://docs.lovable.dev/) | Official product docs (190 pages) | High | no per-page dates; changelog current to 2026-07-24 |
| [v0.app/docs](https://v0.app/docs) + [vercel.com/blog](https://vercel.com/blog) | Official docs + 2 engineering posts | High | docs `Lastmod: 2026-07-24`; blogs 2025-06-01 and 2026-01-07 |
| [docs.replit.com](https://docs.replit.com/) + [replit.com/blog](https://replit.com/blog) | Official docs + engineering blog | High | live; Agent 4 shipped 2026-03-11 |

Caveats that matter:

1. **bolt.diy ≠ bolt.new.** bolt.diy calls itself "the official open source version of Bolt.new"
   ([README](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/README.md)) but
   forked from the code StackBlitz open-sourced in late 2024 and has diverged — the commercial product has since shipped
   Bolt Agent Standard/Max, Plan Mode and Bolt Cloud, none of which exist in the fork. Where the two agree (plan/discuss
   mechanics, quick actions) corroboration is strong. Where only bolt.diy has code, read it as "how this class of product
   is built", not "what bolt.new runs today".
2. **This space moves fast and vendors' own docs go stale.** Replit deprecated Assistant (Dec 2025), deleted starter
   templates, and moved dev DBs off Neon on 2025-12-04 — while still hosting a page that says otherwise. Lovable's FAQ and
   changelog disagree on whether TanStack Start became the default on May 13 or May 21 2026, and its tips-tricks pages
   still describe output as "standard Vite applications". Every claim below carries its date.
3. **Cost per built app is published by nobody.** Question 8 is largely negative results.
4. Two facts are marked LOW CONFIDENCE / inference where the docs are silent; nothing else in this document rests on a
   secondary source, and no Medium/YouTube/listicle material was used.

---

## 1. Planning phase

| | Distinct planning step? | Persisted artifact | Machine-read? | Who approves | Separate model call? |
| --- | --- | --- | --- | --- | --- |
| **bolt.diy** | No — chain-of-thought in the same turn, **"2-4 lines maximum"** | No | No | n/a | No (one streamed call) |
| **bolt.new** | Optional Plan Mode toggle | Markdown in chat; persistence not documented | No | Human ("Implement this plan") | Not documented |
| **Lovable** | Yes — Plan mode | **`.lovable/plan.md`** (latest approved only) | Not documented (markdown, hand-editable) | Human ("Approve") | Not determinable |
| **v0** | Opt-in "Plan Mode" **prompt preset** + `exit_plan_mode` blocking task | No file; a typed message part | **Yes** — `manage_todos` is a distinct part type | Human/API (`approved`/`rejected`/`request-changes`) | No — same run, blocking tool |
| **Replit Agent 4** | Yes — Plan mode | **Task board cards** with per-task plan | **Yes** — dependency edges scheduled | Human ("Start building"); auto-approve opt-in | Not determinable |

**Nobody runs a model over the plan to grade it. In all five columns the approver is a human or nothing.**

bolt.diy's entire planning instruction is a length cap inside the code-writing prompt:

> `<chain_of_thought_instructions>`
> Before providing a solution, BRIEFLY outline your implementation steps… **Be concise (2-4 lines maximum)**

— [`prompts.ts` L282-287](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/prompts.ts#L282-L287)

That prose is streamed in the same assistant message that then opens `<boltArtifact>` and starts writing files. Nothing
parses it — the parser recognises only `<boltArtifact` and `<boltAction`
([`message-parser.ts` L6-8](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/message-parser.ts#L6-L8)).
bolt's discuss mode does produce a plan, and it is explicitly a human artifact:

> When providing a plan, ALWAYS create ONLY ONE SINGLE PLAN per response. The plan MUST start with a clear "## The Plan"
> heading in markdown, followed by numbered steps. **NEVER include code snippets in the plan — ONLY EVER describe the
> changes in plain English.**

— [`discuss-prompt.ts` L22](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/discuss-prompt.ts#L22)

**Lovable** is the only system that persists the plan as a file in the generated project:

> When you approve a plan, the **latest approved version** is saved to `.lovable/plan.md`. … This file represents the
> current plan that Build mode will implement, and you can inspect it like any other project file.

— [features/plan-mode](https://docs.lovable.dev/features/plan-mode)

with the human loop being *edit the markdown, then approve*: "**Edit** the plan directly as markdown… **Approve** the plan
when you are satisfied", after which "Lovable switches to **Build mode**; Implementation begins based strictly on the
approved plan" (same page). Notably Lovable also declines to plan when there is nothing to plan: "Plan mode does not always
produce a structured implementation plan. A plan is created only when there is a clear implementation to propose."

**v0** exposes the plan gate as an API state machine rather than a document — `exit_plan_mode` blocks the run and the
resolution is a three-valued verdict:

> `"name": "plan-exit-response"`, `"description": "Resolves a plan review task. The agent proposed an implementation plan
> and is waiting for approval."` … `"type": "'approved' | 'rejected' | 'request-changes'"`

— [api/v2/reference/messages/resolve-task](https://v0.app/docs/api/v2/reference/messages/resolve-task)

and it separates the reasoning trace from the task list at the schema level: message parts include both `"thinking"`
("The agent's reasoning trace") and `agent-action` names such as `"manage_todos"` (same URL). v0's default, however, is a
direct edit loop; planning is advice for hard cases:

> **Simple Projects (Direct Implementation)** — For straightforward applications with clear requirements, start directly
> with implementation. … **Complex projects (planning first)** — For multi-feature applications, enterprise tools, or
> systems with multiple user roles, start with planning.

— [docs/text-prompting](https://v0.app/docs/text-prompting)

**Replit** goes furthest: the plan *is* scheduler input.

> When you describe what you want to build, Agent can split your request into discrete tasks and place them on a board with
> columns: **Drafts**, **Active**, **Ready**, and **Done**. … Agent proposes a set of tasks, each with a title,
> description, and a detailed plan you can inspect with **View plan**. Review the full list, then choose: **Accept tasks**
> … **Revise plan**
> …Agent automatically detects dependencies. For example, a task that builds a dashboard depends on the task that creates
> the database schema. **Dependent tasks wait until their prerequisites complete.**

— [core-concepts/agent/task-system](https://docs.replit.com/core-concepts/agent/task-system)

Whether any of these planners is a *separate model call* is **not determinable from primary sources** for Lovable, bolt.new
and Replit; for v0 it demonstrably is not (it is a blocking tool inside one agent run).

---

## 2. Scaffold

| | Default stack | User can pick another? | Runnable at turn zero? |
| --- | --- | --- | --- |
| **bolt.diy** | One of 14 fixed GitHub templates, chosen by a throwaway LLM call | Yes, within the 14 — **all frontend**, no backend template | Lockfiles ship, but `npm install && npm run dev` is delegated to the model |
| **bolt.new** | Node.js backend + "any JavaScript framework" frontend | Within JS only — "PHP or Python aren't compatible" | Not documented |
| **Lovable** | **TanStack Start + SSR** (new apps, May 2026); older = React + Vite; Tailwind; Bun | **No stack picker documented** | Yes — hosted preview after a first generation of "a few minutes" |
| **v0** | **Next.js** | Yes but degraded; Nuxt/Svelte via changelog only; **Vue: zero mentions** | Yes — sandbox with a framework-aware dev server |
| **Replit** | Full-stack by default; templates **deleted** | Yes — General Agent: "Any framework or language… Rust, Go, C#" | Yes — "Agent plans, generates, and wires up the app… usually takes a few minutes" |

bolt.diy picks its template with a deliberately cheap, deliberately *un*-thoughtful call:

> MOST IMPORTANT: **YOU DONT HAVE TIME TO THINK JUST START RESPONDING BASED ON HUNCH**

— [`selectStarterTemplate.ts` L63](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/utils/selectStarterTemplate.ts#L63)

The response is XML regex-parsed with a `blank` fallback
([L68-113](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/utils/selectStarterTemplate.ts#L68-L113));
the catalogue is 14 fixed repos — Expo, Astro, Next+shadcn, Vite+shadcn, Qwik, Remix, Slidev, SvelteKit, Vanilla Vite,
Vite React TS, Vite TS, Vue, Angular, SolidJS
([`constants.ts` L34+](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/utils/constants.ts#L34)).
Lockfiles are shipped on purpose —

> exclude lock files / **WE NOW INCLUDE LOCK FILES FOR IMPROVED INSTALL TIMES**

— [`selectStarterTemplate.ts` L152-161](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/utils/selectStarterTemplate.ts#L152-L161)

— but install/boot is an instruction appended to the user's message: "IMPORTANT: Dont Forget to install the dependencies
before running the app by using `npm install && npm run dev`"
([L248](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/utils/selectStarterTemplate.ts#L248)).

Lovable states the fixed stack outright:

> New Lovable apps created from May 13, 2026 use **TanStack Start with server-side rendering (SSR)**. Older apps use React
> + Vite. … Lovable uses **Tailwind** for styling and supports backend functionality through the built-in backend (Cloud),
> Supabase, and third-party APIs.

— [introduction/faq](https://docs.lovable.dev/introduction/faq) (changelog dates the switch 2026-05-21 — an unresolved
internal discrepancy). Project creation offers prompt / remix / template / Figma import — never a framework choice
([features/projects/overview](https://docs.lovable.dev/features/projects/overview)). **Whether the default scaffold
includes shadcn/ui is not determinable from primary sources** — Tailwind and React are named repeatedly across the docs,
shadcn never is.

v0 is explicit that stack freedom costs quality:

> v0 defaults to Next.js, which offers advantages like server actions and API routes for colocating frontend and backend
> code. **While v0 can use other frameworks, Next.js provides the most reliable results.**

— [docs/full-stack-apps](https://v0.app/docs/full-stack-apps)

and its turn-zero environment is a real VM: "Every chat in v0 runs inside its own sandbox… **A framework-aware dev
server**. v0 detects Next.js, Vite, and generic Node.js projects and starts the right command on the right port"
([docs/sandbox](https://v0.app/docs/sandbox)).

Replit deleted the template concept entirely and made the agent the scaffolder:

> Language and framework starter templates (previously called developer frameworks) are **no longer available** on
> Replit… **Start with Replit Agent** — Describe what you want to build from the home page and let Agent scaffold the
> project for you.

— [project-setup/developer-frameworks](https://docs.replit.com/features/project-setup/developer-frameworks)

> **Full-stack by default**: Every web app includes a frontend and backend. Agent sets up API routes, a database, and
> server-side logic as your app needs them.

— [artifact-types/web-apps](https://docs.replit.com/features/artifact-types/web-apps)

Replit never names its default framework in docs; the `replit.md` example uses "React with TypeScript, Tailwind CSS /
Express.js with TypeScript / Neon PostgreSQL with Drizzle ORM"
([replit-dot-md](https://docs.replit.com/features/project-setup/replit-dot-md)) and App Testing is scoped to "Full Stack
JavaScript and Streamlit Python" ([app-testing](https://docs.replit.com/features/agent/app-testing)) — strongly implied,
not stated.

---

## 3. Repair loop trigger

**The single most consistent finding across all four systems: the trigger is a real failure signal, and no system gates a
build behind an LLM reviewer's critique of a diff.**

| | What triggers a fix | Automatic or human-initiated | Reviewer agent grading a builder? |
| --- | --- | --- | --- |
| **bolt.diy** | Shell exit ≠ 0; forwarded `PREVIEW_UNCAUGHT_EXCEPTION` / `PREVIEW_UNHANDLED_REJECTION` | **Human** clicks "Ask Bolt" | **None in the codebase** |
| **bolt.new** | Build error; console error copied by the user | Human | Not documented |
| **Lovable** | Build error → free **"Try to fix"**; logs / runtime output / network during a turn | Mostly human; monitoring is scheduled, not auto-fixing | Read-only **subagents** that "review work against your prompt" but **cannot change the project** |
| **v0** | Streaming errors, post-stream diagnostics, deployment error logs | Deterministic layers automatic; "Fix with v0" human | **None** — `vercel-autofixer-01` is a post-processor |
| **Replit** | Real browser (Playwright), DOM+ARIA, read-only DB queries, new client/server logs | **Automatic** ("Agent will periodically decide to test itself") | Separate **testing** subagent, for context isolation |

In bolt.diy the whole chain is readable. Non-zero exit throws:

```ts
if (resp?.exitCode != 0) {
  const enhancedError = this.#createEnhancedShellError(action.content, resp?.exitCode, resp?.output);
  throw new ActionCommandError(enhancedError.title, enhancedError.details);
}
```

— [`action-runner.ts` L276-279](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/action-runner.ts#L276-L279)

Runtime failures are forwarded out of the preview iframe by configuration and land in the same channel:

```ts
WebContainer.boot({ coep: 'credentialless', workdirName: WORK_DIR_NAME, forwardPreviewErrors: true })
…
webcontainer.on('preview-message', (message) => {
  if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
    workbenchStore.actionAlert.set({ type: 'preview', …, content: `…Stack trace:\n${cleanStackTrace(message.stack || '')}`, source: 'preview' });
```

— [`webcontainer/index.ts` L26-57](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/webcontainer/index.ts#L26-L57)

and the repair is a human pressing a button that replays the raw error as the next user message:

```tsx
onClick={() =>
  postMessage(
    `*Fix this ${isPreview ? 'preview' : 'terminal'} error* \n\`\`\`${isPreview ? 'js' : 'sh'}\n${content}\n\`\`\`\n`,
  )
}
```

— [`ChatAlert.tsx` L72-88](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/chat/ChatAlert.tsx#L72-L88)

There is no reviewer agent anywhere in bolt.diy. The only auxiliary LLM calls in a turn are `createSummary` and
`selectContext`, both purely context-window management
([`api.chat.ts` L121, L163](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/routes/api.chat.ts#L121-L180)),
and the main call passes only MCP tools (`tools: mcpService.toolsWithoutExecute`) — file writes and shell commands are XML
actions parsed out of the stream, not tool calls
([`api.chat.ts` L213](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/routes/api.chat.ts#L213)).
The commercial docs are candid that detection is incomplete and human-driven: a white screen "can mean there's a runtime
error that Bolt can't automatically detect" ([troubleshooting/issues](https://support.bolt.new/troubleshooting/issues)).

**Lovable** makes the trigger a first-class, free UI affordance:

> When a build error appears while Lovable works, a **Try to fix** button appears on the activity card. Click it and
> Lovable scans the logs, finds the issue, and attempts a fix. **Clicking Try to fix doesn't use credits.**

— [features/projects/chat](https://docs.lovable.dev/features/projects/chat)

> Lovable can inspect logs, runtime output, and network activity and iterate on fixes until the issue is resolved or
> clarified. … **Most of these tools run only when you ask for them.**

— [features/agent-mode](https://docs.lovable.dev/features/agent-mode)

> Most verification tools run only when you ask for them. In some cases, the agent may suggest or initiate a tool during
> investigation, but **verification does not run silently in the background.**

— [features/testing](https://docs.lovable.dev/features/testing)

Lovable's subagents are the closest thing anyone ships to a reviewer — and they are explicitly powerless:

> Subagents can search your project, inspect files, run read-only lookups, browse the web when needed, **review work
> against your prompt**, and return findings to Lovable. … Subagents can inform the work, but **they cannot change your
> project. All file changes still come from the main Lovable agent.**

— [features/subagents](https://docs.lovable.dev/features/subagents) (launched 2026-05-27)

No pass/fail grade, score, rubric or blocking gate is documented for them.

**v0** replaced the "have a model review it" instinct with three deterministic-ish layers, and published latency for each:

> LLM Suspense is a framework that manipulates text as it streams to the user. This includes actions like find-and-replace
> for cleaning up incorrect imports… **This process completes within 100 milliseconds and requires no further model
> calls.**
> …we collect errors after streaming and pass them through our autofixers. These include deterministic fixes and **a
> small, fast, fine tuned model trained on data from a large volume of real generations**. … These fixes run in **under
> 250 milliseconds** and only when needed.
> …In our experience, code generated by LLMs can have errors as often as 10% of the time. Our composite pipeline is able
> to detect and fix many of these errors in real time… This can lead to a double-digit increase in success rates.

— [vercel.com/blog/how-we-made-v0-an-effective-coding-agent](https://vercel.com/blog/how-we-made-v0-an-effective-coding-agent) (2026-01-07)

The fixer is a purpose-trained model, not a prompt: "we trained our own custom AutoFix model, **vercel-autofixer-01**, in
conjunction with Fireworks AI using **reinforcement fine-tuning (RFT)**", reported at 8,130 chars/sec
([vercel.com/blog/v0-composite-model-family](https://vercel.com/blog/v0-composite-model-family), 2025-06-01). And v0's
success metric is a build, not a judgement: "A successful generation is one that produces a working website in v0's
preview instead of an error or blank screen" (2026-01-07 post); "Previews now run real builds of your application, which
takes a bit more time than before" ([docs/faqs](https://v0.app/docs/faqs)).

**Replit** is the only system that closes the loop automatically, and it did so by making the *signal* more real:

> We could allow the agent to execute JavaScript in a [notebook] and inject helper functions that allow it to manipulate
> the browser using **Playwright**. … We provide the agent with a stripped-down DOM representation that is augmented with
> ARIA labels and test attributes. … We inject additional utilities functions into the notebook context like the ability
> to do **read-only queries against the application's database**. … We also capture any new client and server logs since
> the last execution.

— [replit.com/blog/automated-self-testing](https://replit.com/blog/automated-self-testing) (2025-12-15)

The motivation is exactly the failure a prose reviewer cannot see:

> A feature that the user requested may appear to work on first inspection… But further interactions reveal that nothing is
> hooked up. Event handlers are missing, the data is mocked, and links go nowhere. ("Potemkin interfaces")

— same post

Replit's second agent exists for **context isolation**, not adjudication: "we split the testing task out into a separate
subagent. The main agent and testing subagent communicate by only passing the necessary context needed for other to do its
job… It helps check the Agent's work and calls it out when it cuts corners" (same post). And the direction of travel on
self-review is telling — Replit made it invisible and non-optional:

> Agent reviews and improves its own code as it builds, catching mistakes before it hands work back to you. This review is
> **built into Agent and runs automatically—it is no longer a setting you turn on or off.**

— [features/agent/agent-modes](https://docs.replit.com/features/agent/agent-modes)

Replit's LLM-judge machinery (ViBench, PRD-graded, Playwright-driven) is **offline eval infrastructure, not the in-product
loop** ([evaluating-and-improving-agent-at-scale](https://replit.com/blog/evaluating-and-improving-agent-at-scale),
2026-06-23).

---

## 4. Supabase / database

| | Who writes SQL | Applied automatically? | Generated TS types | RLS |
| --- | --- | --- | --- | --- |
| **bolt.diy** | Agent, as `/supabase/migrations/*.sql` | **No** — human clicks "Apply Changes" | None | Prompt-mandated: "ALWAYS enable RLS" + policies |
| **bolt.new** | Not documented | Not documented | Not documented | Not documented |
| **Lovable (Cloud)** | Agent | **Yes — "Always allow" is the Cloud default** | Regenerated automatically | Agent writes policies automatically; view read-only; linted at publish |
| **Lovable (external Supabase)** | Agent | **No** — "asks for your approval in chat" | Regenerated after each migration | Same, plus explicit pre-launch warning |
| **v0** | Agent, as `/scripts/*.sql` | **No** — blocks on `confirmed-permissions` | Not documented (zero mentions) | Not documented (zero mentions) |
| **Replit** | Agent (dev DB); **prod migrations generated by `drizzle-kit`, not a model** | Dev: yes. Prod: gated at publish | Via ORM | Not documented |

bolt.diy's prompt requires two actions per schema change, and forbids destructive DDL outright:

> SQL Migrations - CRITICAL: For EVERY database change, provide TWO actions:
> 1. Migration File: `<boltAction type="supabase" operation="migration" filePath="/supabase/migrations/name.sql">`
> 2. Query Execution: `<boltAction type="supabase" operation="query" projectId="${projectId}">`
> …FORBIDDEN: Destructive operations (DROP, DELETE) that could cause data loss
> …ALWAYS enable RLS: `alter table users enable row level security;` … NEVER use diffs, ALWAYS provide COMPLETE file
> content … NEVER update existing migration files

— [`new-prompt.ts` L85-104](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/new-prompt.ts#L85-L104)

The file is written automatically; the execution is not:

```ts
case 'query': {
  // Always show the alert and let the SupabaseAlert component handle connection state
  this.onSupabaseAlert?.({ type: 'info', title: 'Supabase Query', description: 'Execute database query', content, source: 'supabase' });
  // The actual execution will be triggered from SupabaseChatAlert
  return { pending: true };
}
```

— [`action-runner.ts` L507-519](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/action-runner.ts#L507-L519)

The gate is a button labelled **"Apply Changes"**
([`SupabaseAlert.tsx` L164-178](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/chat/SupabaseAlert.tsx#L164-L178)).
No type generation exists in the repo, and the Supabase CLI is unavailable by construction ("Cannot use Supabase CLI",
[`new-prompt.ts` L35](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/new-prompt.ts#L35)).

**Lovable is the important divergence: its default backend is ungated.** The Cloud permission table lists

> **Modify database** | Make schema and policy changes via SQL migrations. **Updates generated types.** | **Always allow**
> …**Always allow**: Lovable automatically performs the action, without asking for review or approval. **This is the
> default for Cloud.**

— [features/cloud](https://docs.lovable.dev/features/cloud)

whereas external Supabase is per-migration human-gated:

> Schema changes run as reviewed migrations: **Lovable writes the SQL, shows it to you, and asks for your approval in
> chat before running it.** After you approve, Lovable executes the migration on your Supabase project, saves the
> migration file in your project's code (under `supabase/migrations/`), and **regenerates the TypeScript types** your app
> uses. Lovable also asks for your approval before inserting or changing data.

— [integrations/supabase](https://docs.lovable.dev/integrations/supabase)

RLS is authored by the agent and *linted*, not proven: "Lovable sets up these rules automatically when it builds features
that store user data" and "The RLS policies view is read-only. To change a policy, ask Lovable in chat"
([features/database](https://docs.lovable.dev/features/database)); the Basic security scan includes RLS policy linting and
runs automatically **on opening the publish dialog**, while the Deep scan's access-control review "detects overly
permissive data-access rules and database functions that bypass row-level security" and is manual only
([features/security](https://docs.lovable.dev/features/security)).

**v0** blocks on an explicit permission payload naming the exact script:

> After the integration is connected, the assistant may ask for permission to run follow-up scripts, such as **database
> setup or migrations**. … While the agent is waiting for your approval, that part includes a `suggestedPermissions`
> array. … To reject the request, ignore the permission request and send any other follow-up message.
> ```json
> { "task": { "type": "confirmed-permissions", "permissions": [{ "type": "ALLOW_DYNAMIC_TOOL_STRICT",
>   "toolName": "SystemAction", "input": { "systemAction": "executeScript", "executeScript": "/scripts/setup-db.sql" } }] } }
> ```

— [api/v2/guides/handling-integrations](https://v0.app/docs/api/v2/guides/handling-integrations)

v0 also connects "to databases like Supabase, Neon, and Upstash **without ORMs by default**"
([docs/full-stack-apps](https://v0.app/docs/full-stack-apps)). **RLS and generated TypeScript types are not mentioned
anywhere in v0's docs, changelog or engineering blog** — with no ORM and no documented RLS story, correctness there rests
entirely on generated code (inference, LOW CONFIDENCE).

**Replit** puts the gate at the dev→prod boundary and — the most directly transferable finding in this section — concluded
that model-generated migrations were the wrong tool:

> You don't need to write SQL yourself. Ask Agent to query or change your data, and it writes and runs the SQL for you.

— [work-with-your-data](https://docs.replit.com/features/data-and-storage/work-with-your-data)

> Agent is not able to modify the production database… Agent can make edits to your development database. At the time of
> publishing, any changes you've made with Agent to the structure of your development database … are applied to your
> production database.

— [development-and-production](https://docs.replit.com/features/data-and-storage/development-and-production)

> **Initially we explored using AI to automate database migrations** by comparing the schema diff between databases.
> However, our experience with models indicated that **a more deterministic approach might be preferable** in this
> instance… eventually settling on Drizzle's `drizzle-kit` CLI package. … if any conflicts arose, we'd ask the user
> questions in order to resolve them or warn them if any changes were deemed potentially destructive.

— [replit.com/blog/production-databases-automated-migrations](https://replit.com/blog/production-databases-automated-migrations) (2025-12-10)

Replit has **no Supabase integration** — the only mention across its docs is an import limitation ("Supabase data:
Existing database records are not migrated", [import-from-providers](https://docs.replit.com/build/import-from-providers)).
Bolt Cloud offers its own DB with Supabase selectable at project creation ([cloud/database](https://support.bolt.new/cloud/database));
that page documents neither migration authoring, RLS, nor type generation.

---

## 5. Separate long-running backend service

| System | Long-running Node/Express/Fastify tier? | Evidence |
| --- | --- | --- |
| **bolt.diy** | Technically possible in WebContainer, actively discouraged | "WebContainer has the ability to run a web server but requires to use an npm package (e.g., Vite, servor, serve, http-server) or use the Node.js APIs"; "**IMPORTANT: Prefer using Vite instead of implementing a custom web server**" ([`prompts.ts` L31-33](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/prompts.ts#L31-L33)); the fine-tuned prompt reduces this to "Use Vite for web servers" ([`new-prompt.ts` L41](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/new-prompt.ts#L41)). **Zero backend templates.** |
| **bolt.new** | No — Bolt Cloud "server functions (sometimes called edge functions)"; JS only | [server-functions](https://support.bolt.new/cloud/database/server-functions), [supported-technologies](https://support.bolt.new/concepts/supported-technologies) |
| **Lovable** | **No.** Static frontend + Supabase-shaped edge functions | "Lovable projects are standard Vite applications and build as **static frontends**" ([external-deployment-hosting](https://docs.lovable.dev/tips-tricks/external-deployment-hosting)); "Edge functions run your app's custom backend code… **There are no servers for you to set up**" and "**There is no create button in the Edge functions view**" ([features/edge-functions](https://docs.lovable.dev/features/edge-functions)) |
| **v0** | Not documented. Next.js route handlers are the answer | "server actions and API routes for **colocating** frontend and backend code" ([full-stack-apps](https://v0.app/docs/full-stack-apps)). One changelog line, "Added **Python Services** support for backend development" (2026-03-03), has **no doc page** ([changelog](https://v0.app/changelog)). Node/Express/Fastify: zero mentions. |
| **Replit** | **Yes, explicitly** | "Reserved VM Deployments run your app on a dedicated virtual machine that **never sleeps**… Always-on API servers… whether the app runs as a web server or a **background worker**"; "Static Deployments are **not compatible** with Replit Apps created using Agent. **Agent builds full-stack apps that need a backend server**" ([deployment-types](https://docs.replit.com/features/publishing/deployment-types)) |

The bolt/Lovable constraint is structural, not editorial. WebContainer "Cannot run native binaries", has no C/C++/Rust
compiler, and Python is "limited to standard library"
([`new-prompt.ts` L27-36](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/new-prompt.ts#L27-L36));
Lovable apps "rely on Supabase-specific services such as authentication, storage, realtime, and edge functions", so even
self-hosting requires Supabase rather than plain Postgres
([deployment-hosting-ownership](https://docs.lovable.dev/tips-tricks/deployment-hosting-ownership)). Lovable's documented
escape hatch for anything server-shaped is still an edge function: "Ask Lovable to create an edge function that acts as a
custom API endpoint or webhook for the external service"
([integrations/supabase](https://docs.lovable.dev/integrations/supabase)).

**What happens if a user asks for a Node/Express API is not determinable from primary sources** for Lovable, bolt.new or
v0 — no page documents a refusal or a redirect behaviour. Only Replit answers it, and the answer is a deployment-type
dropdown.

---

## 6. Chat vs build mode

**Where the mechanism is visible, it is one flag selecting one system prompt — not a different tool set and not a
different agent.** bolt.diy shows it directly:

```ts
chatMode?: 'discuss' | 'build';
```

— [`stream-text.ts` L66](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/.server/llm/stream-text.ts#L66)

```ts
system: chatMode === 'build' ? systemPrompt : discussPrompt(),
```

— [`stream-text.ts` L283](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/.server/llm/stream-text.ts#L283)

No tool is removed; code is forbidden *by instruction* — "You are a technical consultant who patiently answers questions
and helps the user plan their next steps, **without implementing any code yourself**", "NEVER use phrases like 'I will
implement' or 'I'll add'"
([`discuss-prompt.ts` L4, L26](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/discuss-prompt.ts#L4)).
The only *capability* difference is context: the file context buffer is appended only
`if (chatMode === 'build' && contextFiles && contextOptimization)`
([`stream-text.ts` L165](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/.server/llm/stream-text.ts#L165)).
The hand-off is a rendered button whose `message` attribute is replayed as the next user turn:

> `<bolt-quick-action type="implement" message="Implement the plan to add user authentication">Implement this plan</bolt-quick-action>`

— [`discuss-prompt.ts` L97-99](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/common/prompts/discuss-prompt.ts#L97-L99)

The commercial product ships exactly this — "Implement this plan (auto-switches to Build Mode to apply changes)"
([support.bolt.new plan-mode](https://support.bolt.new/best-practices/plan-mode)).

| | Mechanism | Hand-off |
| --- | --- | --- |
| **bolt.diy** | `chatMode` flag → different system prompt, same tools, less context | Quick-action button replays a message |
| **bolt.new** | Plan toggle | "Implement this plan" auto-switches to Build |
| **Lovable** | Toggle next to the input, **Option+P / Alt+P**; "the conversation carries across both" | Approve the plan → switches to Build |
| **v0** | **No discuss-only mode exists.** "Plan Mode" is a saved *prompt preset* applied by checkbox | `exit_plan_mode` approval unblocks the same run |
| **Replit** | Mode selector; Plan mode "without modifying your project's code or data" | "Start building" → Build mode, tasks start |

Lovable: "**Build**: Lovable makes changes directly in your project. This is the default… **Plan**: Lovable discusses,
investigates, and plans without touching your code. You can switch modes at any time, and **the conversation carries
across both**" ([features/projects/chat](https://docs.lovable.dev/features/projects/chat)). Whether the mode difference is
enforced by tool restriction or by prompt is **not documented**.

v0 is the negative case worth noting: the word "mode" in its docs resolves to Design mode (visual editing that still
writes code), permission modes (Ask/Auto/Full, governing terminal autonomy only), and Plan Mode — the last being a
reusable instruction, not a runtime mode: "Instructions are reusable prompts you can save to your account and apply
on-demand… Check the instructions you want to apply" ([docs/instructions](https://v0.app/docs/instructions)).

The industry direction is consolidation: Replit **deprecated** its separate lightweight surface — "**Update (December
2025):** Assistant has been deprecated. For quick, targeted edits, use Lite mode in Agent"
([changelog](https://docs.replit.com/updates/2025/02/21/changelog)) — and Lovable renamed Chat mode to Plan mode "to
better reflect how the mode is intended to be used before implementation"
([features/plan-mode](https://docs.lovable.dev/features/plan-mode)). Two products became one agent with two prompts.

---

## 7. Checkpoints and rollback

| | Granularity | Git-backed | Branch/fork from a checkpoint | Notable limit |
| --- | --- | --- | --- | --- |
| **bolt.diy** | Per message (file map keyed to last message id) | **No** — "Git is NOT available" in WebContainer | Yes — `forkChat(db, chatId, messageId)` | IndexedDB only |
| **bolt.new** | "created automatically or manually"; undocumented | Not stated | No — "you can roll back"; branching is what GitHub is for | — |
| **Lovable** | **Per change** (every agent change + every manual save) | Not documented ("git"/"commit"/"branch" never appear) | Not documented; the alternatives are revert (linear) and **Remix** (fork the project) | **Code-only revert — does not roll back database data**; very old versions become unrevertable |
| **v0** | **Per assistant message that changes code** (manual edits are *not* versioned) | Not natively; optional GitHub gives one commit per message | **Yes** — Fork Chat from a specific version; forks are a runtime concept | Restoring "creates a new, most recent version… to maintain a **linear** version history" |
| **Replit** | **One checkpoint per request** | **Yes** — "Each checkpoint creates a corresponding Git commit" | Yes — roll forward creates "an alternate branch of history" | DB rollback **opt-in**; prod DB never automatic |

bolt.diy snapshots the whole file map after each assistant turn
([`useChatHistory.ts` L308](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/persistence/useChatHistory.ts#L308))
into IndexedDB
([`db.ts` L22](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/persistence/db.ts#L22)),
rewinds via `?rewindTo=<messageId>`
([L79-90](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/persistence/useChatHistory.ts#L79-L90))
and forks via `forkChat`
([`db.ts` L225](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/persistence/db.ts#L225)).
It *cannot* be git-backed — the runtime has no git.

Lovable's is the most complete UI and the most explicit about the hard limit:

> Every change Lovable makes to your project creates a version automatically. There is no save button…
> **Reverting restores your project's code only**, and redeploys your app's edge functions to match. **It does not restore
> or roll back your database data.** If messages after that version added records, changed data, or ran migrations against
> your data, reverting the code does not undo those data changes.
> …Revert is **all or nothing per version**: it restores the entire project to that state.

— [features/projects/history](https://docs.lovable.dev/features/projects/history)

v0 ties versioning to messages and keeps history linear:

> **Each time v0 updates a code block from a message, it creates a new version.** Non-message actions (such as editing code
> or modifying files directly) do not generate new versions. … Restoring an old version creates a new, most recent version
> using the restored code **to maintain a linear version history**.

— [docs/versions](https://v0.app/docs/versions)

with the same granularity preserved into git when GitHub is connected — "**Auto-commits:** Every message you send that
changes code automatically creates a commit" ([docs/github](https://v0.app/docs/github)) — and real forking in the API
("Creates a new chat fork (duplicate) from a specific version… Useful for branching off alternate directions without
modifying the original conversation").

Replit ties checkpoint granularity to billing — "**One checkpoint per request** eliminates intermediate checkpoints and
reduces billing noise" ([ai-billing](https://docs.replit.com/billing/ai-billing)) — and captures "Project files … AI
conversation context … Environment configuration … Agent memory … Database contents", generating a git commit per
checkpoint, with roll-forward producing alternate history and database rollback **opt-in**
([checkpoints-and-rollbacks](https://docs.replit.com/features/version-control/checkpoints-and-rollbacks)). Its analogue to
branching *for work* is the task system: tasks "start running in isolated copies of your project… Your main version stays
untouched until you choose to apply changes", with "AI-assisted conflict resolution"
([task-system](https://docs.replit.com/core-concepts/agent/task-system)).

Bolt's docs concede the ceiling honestly: "if you need to work on your project outside of Bolt or require advanced
collaboration, branching, or detailed history, Bolt's built-in system may not be sufficient. That's where GitHub comes in"
([version-history-github](https://support.bolt.new/concepts/version-history-github)).

---

## 8. Cost and latency

**Nobody publishes cost-per-app or a time-to-first-working-preview benchmark.** What is published:

**Lovable** — the only vendor with a per-request cost table, illustrative but concrete
([credits-and-usage](https://docs.lovable.dev/introduction/credits-and-usage)):

> | User prompt | Work done | Credits used |
> |---|---|---|
> | Make the button gray | Changes the button styles | 0.50 |
> | Remove the footer | Removes the footer component | 0.90 |
> | Add authentication | Adds login and authentication logic | 1.20 |
> | Build a landing page with images | Creates a landing page with generated images, a theme, and sections | 2.00 |

with "Plan mode | Every message costs **1 credit** | Build mode | Cost depends on the complexity of the request and the
work completed", credits at Pro ~$0.25–0.30 and Business ~$0.50–0.60 each, per-message actuals inspectable ("Click the
three-dot menu below any Lovable response in the chat to see its exact cost"), and — importantly for repair-loop
economics — **"Try to fix" costs nothing**, security scans are free, and "Stopped Build mode requests are charged based on
the work completed so far". Latency: "Build and publish your first Lovable app in **about ten minutes**, from your first
prompt to a live URL"; "The first version takes a few minutes"
([getting-started](https://docs.lovable.dev/introduction/getting-started)).

**v0** — plan pricing published (Free $5/mo credits, Premium $20, Plus $30/user, Business $100/user), per-token rates
deliberately not: "The number of tokens per credit used depends on the model. You can view model costs by hovering each in
the model selector" ([docs/pricing](https://v0.app/docs/pricing)). Repair is subsidised the same way Lovable's is: "You get
up to **20 free Fix with v0 uses per day**" ([docs/agentic-features](https://v0.app/docs/agentic-features)). Latency
figures: publish "usually **30-60 seconds**" ([quickstart](https://v0.app/docs/quickstart)); repair layers "within 100
milliseconds" and "under 250 milliseconds"; sandboxes start "in seconds". Time-to-first-preview: not published, and the
FAQ concedes a regression — "Why does v0 feel slower? Previews now run real builds of your application".

**Replit** — effort-based pricing, "**All Agent interactions are billable** — whether Agent responds with text guidance or
makes code changes, there is always a charge" ([ai-billing](https://docs.replit.com/billing/ai-billing)); Lite mode
"quick, targeted changes (**10-60 seconds**)" ([agent overview](https://docs.replit.com/features/agent/overview)); first
app "usually takes a few minutes" ([your-first-app](https://docs.replit.com/build/your-first-app)). The single most useful
number anyone publishes about an automated verification loop is Replit's: a self-testing flow "able to perform complex,
multi-hundred step testing at a **median cost of $0.20 per session**", alongside autonomy raised "from 20 minutes to over
200 minutes" ([automated-self-testing](https://replit.com/blog/automated-self-testing)).

**bolt** — bolt.diy publishes nothing (BYO API key). bolt.new: "Most of your token usage comes from Bolt reading,
understanding, and syncing your project files, so larger projects use more tokens per message"; free plan "300K tokens"
daily; no per-message or per-project figures ([tokens](https://support.bolt.new/account-and-subscription/tokens)). Plan
Mode is pitched partly as cost control — it helps "save tokens by avoiding unnecessary code exchanges"
([plan-mode](https://support.bolt.new/best-practices/plan-mode)).

Dollar cost per finished app and median time-to-working-app are **not determinable from primary sources** for any of the
four.

---

## Implications for Agent Foundry

`workflows/web-app-v1.yaml` is `plan-gate → architecture-gate → implementation-gate → deterministic-verification →
browser-verification → diff-approval → release-assessment`, the first three being `quality-loop`s of (setup agent → LLM
reviewer agent → LLM repair agent, `maxIterations: 3`).

### Corroborated by how the incumbents actually work

- **A plan/discuss mode that cannot touch code.** Universal — Lovable Plan mode, Replit Plan mode, bolt Plan/Discuss mode,
  v0's `exit_plan_mode`. Agent Foundry's planning phase is directionally right *as a mode*.
- **A persisted plan artifact.** Corroborated by Lovable, which writes the approved plan to `.lovable/plan.md` inside the
  generated project and lets the human edit it as markdown before approving. Agent Foundry's `plan.current` artifact has a
  real counterpart.
- **Deterministic verification and browser verification as gates.** Strongly corroborated — these are the *only* repair
  triggers the incumbents trust. Replit spent an engineering post building precisely Agent Foundry's `browser-verification`
  node and reports it is what catches "Potemkin interfaces"; v0 made previews run real builds even at a latency cost.
  Nodes 4 and 5 are the most state-of-the-art parts of the pipeline.
- **A human diff/approval gate.** Corroborated everywhere: bolt's "Apply Changes", v0's `confirmed-permissions`, Lovable's
  per-migration approval on external Supabase, Replit's "Start building". `diff-approval` is normal.
- **Human-gated SQL, forward-only migrations, RLS-by-default.** bolt's prompt reads almost like a spec for Agent Foundry's
  existing rules (never edit an existing migration, complete file content, `ENABLE ROW LEVEL SECURITY`, no destructive
  DDL), and Lovable ships an equivalent gate for external Supabase. Keep this. Replit adds a warning worth heeding:
  it *tried* AI-authored migrations and deliberately moved to deterministic `drizzle-kit` diffs.

### Contradicted

- **The LLM reviewer as a blocking gate has no counterpart in any primary source.** bolt.diy has zero reviewer agents in
  its codebase; its only auxiliary LLM calls are `createSummary`/`selectContext` for context-window fitting. Replit
  *removed* its review toggle and folded review into the builder ("no longer a setting you turn on or off"). v0's second
  model is a 250 ms post-processor, not a judge. Lovable's subagents may "review work against your prompt" but "cannot
  change your project" and gate nothing. Agent Foundry's `plan-reviewer` and `architecture-reviewer` — models grading
  prose, with authority to block — are unique to Agent Foundry.
- **Reviewing artifacts that contain no code, to compute one bit.** `plan-gate` + `architecture-gate` can burn up to ten
  LLM calls before a file exists, and each approval predicate reads exactly one machine-readable field: `approved: true`
  at a JSON path (`workflows/web-app-v1.yaml` L67-70, L132-135). The incumbents' equivalent budget is *2-4 lines of
  chain-of-thought inside the turn that writes the code*, or a human clicking Approve for free.
- **Prose task decomposition that nothing consumes.** Contradicted from both directions. Replit's plan is task cards with
  dependency edges and "dependent tasks wait until their prerequisites complete"; v0 types `manage_todos` separately from
  `thinking` in its message schema. If decomposition matters it must be *executable structure*; if it does not, it should
  be chain-of-thought. Agent Foundry's current middle ground — prose that costs full model calls and drives nothing — is
  the worst of both.
- **A single `implement` node building the entire app.** Contradicted by Replit (N scheduled tasks in isolated copies with
  dependency ordering and per-task verification) and, from the opposite direction, by bolt/Lovable/v0, whose turns are
  small *because* a human re-prompts constantly and every turn ends at a running preview. Agent Foundry has neither the
  task scheduler nor the human cadence — just one large call.
- **Turn zero is not runnable.** `harness/scaffolds/nextjs/` is application-side source only — `app/`, `lib/`,
  `middleware.ts`, `supabase/` — with **no `package.json` and no lockfile**. Every incumbent treats a booted preview as the
  starting state: bolt.diy ships lockfiles on purpose, v0 boots "a framework-aware dev server", Lovable's first version is
  live in "a few minutes", Replit's first-app flow ends at "Confirm the app works in Preview". A scaffold that cannot
  `npm install && npm run dev` at turn zero means the first real signal arrives only *after* the monolithic `implement`
  node.
- **The ordering is backwards.** Every incumbent reaches a running preview first and derives repair work from its
  failures. Agent Foundry emits ~14 prose calls, then code, then checks. The observed $2.91 / 13 min zero-code run is the
  predicted output of that ordering, not an anomaly. For scale: Replit's *entire* multi-hundred-step browser self-test
  session has a published median cost of $0.20.
- **Repair should be free or near-free.** Both Lovable ("Clicking Try to fix doesn't use credits") and v0 ("20 free Fix
  with v0 uses per day") explicitly do not charge for fixing their own errors. Agent Foundry's repair agents are full-price
  model calls inside a `maxIterations: 3` loop, which makes iteration the most expensive thing the pipeline does.

### Cheapest changes that move Agent Foundry toward the evidence

1. **Delete `review-plan`/`repair-plan` and `review-architecture`/`repair-architecture`.** Fold planning into the implement
   node's prompt with a hard length cap, keeping the artifacts as human-inspectable output. Removes up to eight model calls
   per run and matches every incumbent.
2. **Make the scaffold boot.** Add `package.json` + lockfile to `harness/scaffolds/nextjs/` and run install + dev server
   before the first LLM call, so `deterministic-verification` and `browser-verification` have a baseline to fail against
   from minute zero rather than after the monolith.
3. **If the plan survives, give it a machine consumer.** A typed task list the orchestrator schedules (Replit's model), so
   decomposition tokens buy execution order instead of a boolean. Otherwise shrink it to chain-of-thought (bolt's model).
4. **Split `implement`.** One node per plan task, each ending at a verification run, is what both Replit's task board and
   the human-cadence products approximate.
5. **Keep `deterministic-verification`, `browser-verification` and `diff-approval` unchanged.** That is where the
   incumbents' real engineering effort went, and Agent Foundry already has them.
