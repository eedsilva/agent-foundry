# Stack: Next.js web application

Unless the approved architecture says otherwise:

- Use current Next.js App Router conventions and React server/client boundaries deliberately.
- Use TypeScript with strict mode.
- Keep domain logic outside React components and route handlers.
- Validate untrusted input at process boundaries.
- Prefer server-side data access and explicit API contracts.
- Include loading, error, and empty states for user-facing workflows.
- Avoid global mutable state and giant all-purpose components.
- Do not introduce a database, queue, or state library without a demonstrated need.
