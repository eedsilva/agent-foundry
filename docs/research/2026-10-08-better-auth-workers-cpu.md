# Does Better Auth password hashing fit the Workers Free CPU limit?

Research for [#733](https://github.com/eedsilva/agent-foundry/issues/733) (part of #730). Date: 2026-10-08.
Better Auth at the time of writing: `v1.7.7` (latest release); `@better-auth/utils` `0.5.0`.

**Short answer:** No, not reliably. Better Auth >= 1.6 on Workers already uses native
scrypt (BoringSSL via `node:crypto`), not pure-JS `@noble/hashes`. Its default parameters
still cost roughly 60 ms of CPU per hash, which is about 6x the 10 ms Free budget. On
Workers Free, nothing that meets OWASP guidance fits in 10 ms. Workers Paid (30 s
default CPU) handles the default config comfortably.

## 1. Cloudflare Workers CPU limits (verified)

Source: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

| | Free | Paid |
|---|---|---|
| CPU time per HTTP request | **10 ms** | **30 s default, configurable up to 5 min** (`limits.cpu_ms`, max 300000) |
| Memory per isolate | 128 MB | 128 MB |
| Subrequests per invocation | 50 | 10,000 |
| Requests per day | 100,000 | n/a |

- "CPU time measures how long the CPU spends executing your Worker code." Time spent
  waiting on `fetch()`, KV, or database queries (D1 included) does not count.
- Grace: "Each isolate has some built-in flexibility to allow for cases where your Worker
  infrequently runs over the configured limit. If your Worker starts hitting the limit
  consistently, its execution will be terminated." The docs do not quantify this
  flexibility. An overrun returns Error 1102 "Worker exceeded resource limits".
- Free plan: the 10 ms limit cannot be raised.

## 2. What Better Auth does today (verified from source)

- `packages/better-auth/src/crypto/password.ts` re-exports `hashPassword`/`verifyPassword` from
  `@better-auth/utils/password`
  ([source](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/crypto/password.ts)).
- `@better-auth/utils` `package.json` maps the `./password` export with a **`workerd`**
  condition, and a `node` condition, to `password.node.mjs`. That build calls
  `node:crypto.scrypt`. Other runtimes fall back to `password.ts`, which uses
  `@noble/hashes` `scryptAsync`, a pure-JS implementation
  ([package.json](https://github.com/better-auth/utils/blob/main/package.json),
  [password.node.ts](https://github.com/better-auth/utils/blob/main/src/password.node.ts),
  [password.ts](https://github.com/better-auth/utils/blob/main/src/password.ts)).
- Wrangler bundles with the conditions `["workerd", "worker", "browser"]` by default
  ([wrangler bundle.ts](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/deployment-bundle/bundle.ts)),
  so a Wrangler build gets the native path. That path imports `node:crypto`, so it needs
  the `nodejs_compat` flag. *(Unverified: what happens without `nodejs_compat`, and
  whether non-Wrangler bundlers such as vinext or OpenNext pass `workerd`.)*
- The switch to native scrypt shipped in **Better Auth 1.6.0** ("Use non-blocking scrypt for
  password hashing", #8836 / PR #8685; changelog). Better Auth 1.4.x and 1.5.x use the
  pure-JS noble path everywhere.
- Default parameters (both paths): **N=16384, r=16, p=1, dkLen=64**, 16-byte random salt,
  NFKC normalization. Stored as `saltHex:keyHex`. The parameters are not encoded in the
  stored hash.
- Override: set `emailAndPassword.password.{hash, verify}`. The docs show an Argon2
  example ([email-password docs](https://github.com/better-auth/better-auth/blob/main/docs/content/docs/authentication/email-password.mdx)).

### Known issues

- [better-auth#8860](https://github.com/better-auth/better-auth/issues/8860) (v1.4.18, 2026-03-31):
  sign-up "intermittently fails with Worker exceeded CPU time limit". The reported fix was a
  custom hash using native `scryptSync` with the same parameters. The issue was closed by
  PR #8685. The reporter's plan (Free or Paid) is not stated.
- [better-auth#969](https://github.com/better-auth/better-auth/issues/969) (comment
  2025-07-01): the same CPU-limit failure on Hono and Workers, with the same workaround.
- A bot reply on #8860 claims that noble scrypt "takes ~4.5–5s CPU on Workers". This is
  **unverified** and comes from an automated reply, so do not rely on it.

## 3. Native crypto still counts as CPU time (verified from workerd source; not stated in CF docs)

- workerd's `node:crypto.scrypt` calls `cryptoImpl.getScrypt(...)` synchronously
  inside a `new Promise` executor, so the work runs on the isolate thread. Unlike Node,
  there is no libuv thread pool
  ([crypto_scrypt.ts](https://github.com/cloudflare/workerd/blob/main/src/node/internal/crypto_scrypt.ts)).
  Work on the isolate thread is CPU time. Making the call async does not move it off the
  request's budget.
- The Cloudflare Web Crypto docs do not say whether `crypto.subtle` time counts toward CPU
  time ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)).
  Inference, **unverified by docs**: it is native code on the same isolate, so treat it as
  counted. Only I/O waits are documented as excluded.
- **Production PBKDF2 cap:** `DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000`. Above it,
  `deriveBits` throws `DOMNotSupportedError` "Pbkdf2 failed: iteration counts above 100000 are not supported".
  The workerd source comment says this limit is "*WAY* below the recommended minimum".
  **Local `workerd` / `wrangler dev` overrides it to no limit** (`server.c++`), so a config
  above 100k passes locally and fails in production.
  ([limit-enforcer.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h),
  [impl.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/crypto/impl.c++))
- scrypt cost cap: N·r·p ≤ 2^20. Better Auth's default (2^18) fits.
- Web Crypto `deriveBits` supports PBKDF2, HKDF, ECDH, and X25519. It does **not** support scrypt or Argon2.

## 4. CPU cost estimates

Local proxy measurement only, **not measured on Workers**. Node 22.22 native BoringSSL
on an Apple M1 Pro, average of 5 runs. workerd uses the same BoringSSL primitives, but
Cloudflare's server CPUs and per-isolate overhead differ.

| Config | ms / hash | OWASP status |
|---|---|---|
| scrypt N=2^14 r=16 p=1 (**Better Auth default**) | ~61 | below OWASP's lowest scrypt tier (N·r·p 262k vs ≥655k) |
| scrypt N=2^14 r=8 p=1 | ~31 | below |
| scrypt N=2^12 r=8 p=1 | ~7 | far below (~1/20 of the lowest tier) |
| PBKDF2-SHA256 100k (**Workers prod max**) | ~12 | 1/6 of the OWASP 600k recommendation |
| PBKDF2-SHA256 50k | ~6 | 1/12 |
| PBKDF2-SHA256 600k (OWASP) | ~72 | meets, but **impossible on Workers** (cap 100k) |

Sign-up hashes once and sign-in verifies once, so each costs about one hash plus Better
Auth's request overhead, which was not measured. D1 query time is I/O and does not count.

## 5. OWASP guidance

Source: [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

- Order of preference: Argon2id, then scrypt, then bcrypt (legacy only), then PBKDF2 (when FIPS-140 is required).
- scrypt minimum tiers, all equivalent: N=2^17 r=8 p=1 · 2^16/8/2 · 2^15/8/3 · 2^14/8/5 · 2^13/8/10.
- PBKDF2-HMAC-SHA256: 600,000 iterations. PBKDF2-HMAC-SHA512: 220,000.
- "calculating a hash should take less than one second". "Strike a balance between security and performance."

Better Auth's default is already weaker than OWASP's minimum scrypt tier, about 40% of
the N·r·p product (this ratio is computed here, not taken from OWASP). The 10 ms Free
budget is about two orders of magnitude below what OWASP-level hashing costs.

## 6. Recommendation

- **Paid is required for production-grade email/password on Workers.** Use Better Auth
  >= 1.6 defaults (native scrypt via `nodejs_compat`) on Workers Paid. About 60 ms is far
  under the 30 s default, and no custom hash is needed. Better: raise the parameters to an
  OWASP tier, for example a custom `hash`/`verify` with N=2^14 r=8 p=5. The cost is
  N·r·p ≤ 2^20, so workerd allows it. Encode the parameters in the stored string so they
  can be upgraded later.
- **On Workers Free, do not ship email/password by default.** Prefer OAuth or magic-link
  sign-in, which need no password hash. If password auth on Free is unavoidable, the only
  configs that fit about 10 ms are weak: native scrypt N=2^12 r=8 p=1 (~7 ms locally) or
  PBKDF2-SHA256 at ≤ 50k iterations through `crypto.subtle` (~6 ms locally). Prefer
  scrypt, because it is memory-hard. Pass it as a custom
  `emailAndPassword.password.{hash, verify}` with a versioned format (for example
  `s1$N$r$p$salt$key`) so you can rehash on login after upgrading to Paid. Document this
  as a security trade-off, roughly 1/20 of OWASP's work factor.
- **Never configure PBKDF2 above 100k iterations on Workers.** It works under
  `wrangler dev` and throws in production.
- **Do not use Better Auth < 1.6 on Workers.** It hashes with pure-JS scrypt and hits the
  CPU limit intermittently, per #8860 (the reporter's plan is unknown).

## Open questions

1. What is the real CPU time on Cloudflare hardware? Measure the default and candidate
   configs in a deployed Worker (Workers Logs `cpuTime`, or the dashboard CPU metrics). The
   local M1 numbers are only a proxy.
2. How big is the Free-plan "built-in flexibility"? Does an occasional 60 ms sign-in
   survive on Free, and at what rate does it start getting terminated? The docs do not say.
3. Does `crypto.subtle` time count as CPU time? This is inferred, not documented.
4. Do vinext/OpenNext builds resolve the `workerd` export condition? If they do not,
   Better Auth falls back to pure-JS noble scrypt and is much slower.
5. Better Auth request overhead beyond the hash (session creation, cookie signing with
   HMAC, and so on) was not measured.
