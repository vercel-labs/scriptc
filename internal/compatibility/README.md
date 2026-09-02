# Node compatibility ledger

This workspace package owns scriptc's Node.js parity system.

- `node-v24.json` pins the Node release tag, commit, and canonical docs/source inputs.
- `static-support.json` overlays dedicated compiler paths and their internal test evidence on the compiler's generated surface manifest.
- `dynamic-support.json` is the implementation-owned dynamic-island module/global registry. It also generates `packages/runtime/src/scr_island_manifest.h`, so runtime exports and compatibility claims share one source.
- `generated/node-v24-internal.json` is the engineering ledger, including implementation evidence and repository test paths.
- `generated/node-v24-backlog.json` is the internal tier-specific work queue. It separates verification, implementation, explicit-refusal replacement, and partial-surface audit work, and prioritizes stable Node APIs above experimental, deprecated, and legacy APIs.
- `docs/src/generated/node-v24-compatibility.json` is the stripped public artifact consumed by the docs website. It contains compiler-relevant runtime APIs, statuses, verification bases, and user-facing details; documentation, metadata, command-line/configuration entries, and rows that are N/A in both tiers remain internal.

Statuses are evidence-aware: `supported` and `partial` require test evidence; `refused` requires an explicit compiler diagnostic or dynamic throwing stub; `not-implemented` is the actionable backlog for an owned API family with no implementation match; `by-design` records an architectural exclusion; `unreviewed` still needs classification; and `not-applicable` is not a runtime API for that execution tier.

Run `pnpm node-compat:backlog` from the repository root for a summary. The filters `--tier`, `--action`, `--priority`, `--chapter`, and `--status` compose; use `--format=json` or `--format=tsv` for tooling.

Run `pnpm node-compat` from the repository root after changing the Node pin or either support manifest. `pnpm node-compat:check` is the offline drift/evidence gate; `pnpm --filter @internal/compatibility check:upstream` additionally verifies the pinned upstream inputs over the network.
