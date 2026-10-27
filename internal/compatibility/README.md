# Node compatibility ledger

This workspace package owns scriptc's Node.js parity system.

- `node-v24.json` pins the Node release tag, commit, and canonical docs/source inputs.
- `static-support.json` overlays dedicated compiler paths and their internal test evidence on the compiler's generated surface manifest.
- `generated/node-v24-internal.json` is the engineering ledger, including implementation evidence and repository test paths.
- `pnpm node-compat:backlog` derives the internal tier-specific work queue from the ledger; it is not committed. It separates verification, implementation, explicit-refusal replacement, and partial-surface audit work, and prioritizes stable Node APIs above experimental, deprecated, and legacy APIs.
- `docs/src/generated/node-v24-compatibility.json` is the stripped public artifact consumed by the docs website. It contains compiler-relevant runtime APIs, statuses, verification bases, and user-facing details; documentation, metadata, command-line/configuration entries, and rows that are N/A for native execution remain internal.

Statuses are evidence-aware: `supported` and `partial` require test evidence; `refused` requires an explicit compiler diagnostic or native throwing stub; `not-implemented` is the actionable backlog for an owned API family with no implementation match; `by-design` records an architectural exclusion; `unreviewed` still needs classification; and `not-applicable` is not a runtime API for that execution tier.

Run `pnpm node-compat:backlog` from the repository root for a summary. The filters `--tier`, `--action`, `--priority`, `--chapter`, and `--status` compose; use `--format=json` or `--format=tsv` for tooling.

Run `pnpm node-compat` from the repository root after changing the Node pin or the support manifest. `pnpm node-compat --local` does the same without network access while the pin is unchanged, by reclassifying the committed ledger rows; after a merge, `node scripts/regen-generated.mjs` regenerates every generated file instead of a hand merge. `pnpm node-compat:check` is the offline drift/evidence gate; `pnpm --filter @internal/compatibility check:upstream` additionally verifies the pinned upstream inputs over the network.

## npm packages that compile as builtins

The ledger counts Node APIs, so npm packages that compile as a Node builtin have no rows. `packages/compiler/src/frontend/builtin-package-aliases.ts` lists them, each with the checked major versions and the reason its module is that builtin on Node 24. One entry is a documented divergence rather than an identity: `readable-stream` 2.x, 3.x and 4.x compile as `node:stream`; for 2.x and 4.x that is the package's `READABLE_STREAM=disable` behavior. Without that variable Node runs the package's own JavaScript streams. The `tests/corpus/readable-stream-disable` program pins the disabled behavior. 3.x, a copy of Node 10's streams, cannot run disabled on Node 24 (its disable branch throws), so `tests/corpus/readable-stream-3` pins only behavior its own streams share with the builtin.
