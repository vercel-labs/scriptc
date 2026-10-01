# Compatibility lookup: hill-climbing record

## Scope and checkpoints

This is a lab-only optimization of the compatibility-assessment journey: open `/compatibility`, type an API name, and inspect its static/dynamic status and verification details. Returning developers plausibly repeat this lookup, but there is no goal-attempt usage data; neither its frequency nor its share of user activity is established. Screening found multi-second browser stalls during ordinary search prefixes, so the hill is browser rendering rather than compiler execution or server throughput.

The target is a reduction in input-to-usable-result latency greater than measurement noise, with all results, independent tier filters, expansion, hover details, keyboard access, and table geometry preserved. The user supplied no time limit. The work budget stayed within one coherent journey: three bottleneck experiments, two retained changes, a complete-journey before/after comparison, and correctness/regression gates. The retained scope includes no deployment, compatibility-status changes, pagination, or virtualization.

## Workload and measurement

The baseline is commit `2069684`, using the generated Node 24.15.0 public census: 3,662 rows. Production Next.js builds ran on an Apple M3 arm64 host, Darwin 25.6.0, Node 24.15.0, with Chrome for Testing 154.0.8037.57 and a 1440×1000 viewport. Each phase has nine attempts, measured separately at normal CPU speed and Chromium's 4× CPU throttle. The throttle is a constrained-CPU simulation, not a measurement on a physical phone. OS caches were not flushed and no network throttle was applied.

The browser captures the actual input/click event and records completion after two animation-frame callbacks, allowing a paint opportunity. This is a browser-side usable-result proxy, not a physical display measurement. The complete lookup types `readFile` sequentially without an added typing delay and measures from its first input to the final matching result. Automation scheduling between keystrokes remains in that journey interval. Untimed assertions compare every displayed label against an independent oracle over the published census, so omitting or showing stale results cannot masquerade as a speedup.

The server delivers prebuilt HTML and the unchanged static census. Navigation/data Resource Timing is saved separately from input/render samples; these local response intervals include transport and are not pure server CPU measurements. There are no server-code changes or claimed network gains. The result checks, screenshots, and V8 render-count instrumentation run outside latency measurements. A run contending with orphaned native-test workers was discarded; the retained matched runs were isolated from those workers.

## Complete-journey results

| CPU profile | Sequential `readFile` p50 before → after | Sample p95 before → after | p50 reduction |
| --- | --- | --- | --- |
| Normal | 1,087.7 → 514.2 ms | 1,491.0 → 556.9 ms | 52.7% |
| 4× throttle | 3,799.8 → 1,972.4 ms | 4,644.6 → 2,101.2 ms | 48.1% |

With nine attempts, the reported nearest-rank sample p95 is the maximum sample; it is not a population p95 estimate. The final broad `r` prefix is 357.0 ms p50 normally and 1,351.4 ms at 4× throttle. Expanding the entire census is 307.8 and 1,274.7 ms respectively. Exact samples, environment, resource timings, and each experiment's before/after evidence are in [results.json](./compatibility-lookup/results.json).

## Experiments and counter validation

1. **Retained: mount tooltip content only while a badge is hovered or focused.** Expanded-table elements fell from 90,922 to 58,649 with all 3,662 rows retained. In the matched first experiment, the broad-prefix p50 fell from 643.5 to 304.3 ms normally and from 3,014.7 to 1,396.2 ms at 4× throttle. Reduced DOM work therefore accompanied a substantial wall-clock reduction on the same workload; the element count was not adopted merely because it was easy to count.
2. **Retained: memoize unchanged status and stability badges.** The `r` → `re` interval previously called the status renderer 6,128 times; it now records zero calls for retained badges. The matched pair reduced that interval's p50 from 93.8 to 82.1 ms normally and from 382.8 to 349.1 ms at 4× throttle. A deterministic 10,000-resample median-difference bootstrap over those nine-sample sets (LCG seed 42, independent resampling of before/after samples) gave positive 95% intervals of approximately 2.7–20.6 and 15.9–67.3 ms. This is supporting lab evidence, not a field guarantee. The production change is two React memo wrappers; no custom comparator or cache invalidation policy was added.
3. **Rejected: CSS `content-visibility` on table rows/cells.** Row containment gave no useful improvement. Cell containment reduced layout work but changed total table height from about 210,587 to 67,864 px in the broad-prefix experiment, changing scroll geometry. That apparent speedup was not retained.

## Correctness, visuals, and ratchets

Browser tests were established before optimization: the old implementation failed the no-hidden-tooltip guard and later failed the retained-render ceiling with 6,128 calls. The existing search/filter path passed its independent census comparison before changes. The final four browser contracts cover all-row reachability, search/tier filters/reset, status and stability render counts, full tooltip text, and overlapping pointer/keyboard focus lifetimes. They pass with both the measurement browser and Playwright's bundled Chromium 153.0.8010.12.

The docs gate now runs these contracts after drift checking, TypeScript checking, and the production build. A required CI job installs Chromium and runs the gate. Stable ceilings are zero tooltip nodes in an inactive expanded matrix, at most `17 × census rows + 500` document elements, and at most 16 retained-renderer calls per badge kind during `r` → `re`. V8 may omit zero-call functions; a subsequent actual hover must produce calls in the same renderer, proving the counter is live. Wall-clock timing remains a benchmark/monitoring result, never a noisy CI assertion.

Settled tooltip content and table dimensions match before/after on desktop and a 390×844 viewport. The desktop tooltip screenshot is pixel-identical; mobile differs in 92 of 912,600 color channels. The mobile tooltip's clipping is pre-existing and unchanged. Review [desktop before](./compatibility-lookup/before-desktop.png), [desktop after](./compatibility-lookup/after-desktop.png), [mobile before](./compatibility-lookup/before-mobile.png), and [mobile after](./compatibility-lookup/after-mobile.png). These stills do not establish transient animation timing; hover/focus transitions should also be checked during field verification.

## Reproduce

Use the repository-pinned Node 24.15.0 and root pnpm 11.1.3 (the docs workspace selects pnpm 10.23.0). Install both workspaces and the test browser:

```bash
pnpm install --frozen-lockfile
pnpm --dir docs install --frozen-lockfile
pnpm exec playwright install chromium
```

From `docs/`, use a separate production output directory so a running development server is not disturbed:

```bash
NEXT_DIST_DIR=.next-check pnpm check
mkdir -p /tmp/scriptc-hill
NEXT_DIST_DIR=.next-check SCRIPTC_DOCS_RESULT=/tmp/scriptc-hill/journey-after.json pnpm bench:compatibility
```

The benchmark normally starts and stops its own production server on port 3108. `SCRIPTC_DOCS_URL` explicitly selects an existing server instead. `SCRIPTC_BROWSER_PATH` selects an installed Chromium executable; set it to the same browser revision as the baseline for timing comparisons. `SCRIPTC_DOCS_ITERATIONS` controls repetitions. Do not compare runs sharing cores with native builds/tests. The browser contracts use the root Playwright dependency, while docs dependencies remain in the standalone workspace.

## Validation and stopping point

Workspace build, compatibility drift checking, strict TypeScript checking of the browser tests, and the complete docs gate passed during the original implementation. Sandbox preflight failed because the Vercel session expired. The prescribed local plain/sanitized fallback ran with four workers on `2069684`; it is not green. The plain lane passed 7,267 tests and failed one: Zig COFF dry-run cache conformance (`ENOENT` scanning the cache `bin` directory) after 34.7 s under load. The same test passed in 5.9 s in an isolated one-worker rerun, so it is an undiagnosed intermittent failure. The sanitized lane failed eight tests, all because the sanitizer runtime wrote `No external symbolizers found … Is PATH set?` to stderr where byte-exact stderr was expected. The fork-IPC fixture reproduces this deterministically in isolation: it spawns its child with an environment lacking `PATH`, and the self-hosting cases deliberately run without Node on `PATH`. This patch changes no compiler, runtime, or harness code. Upstream CI's macOS 15 `san` shards passed on the same base commit, suggesting a host-specific failure without establishing its cause. The branch was rebased onto `0e764aa` after the docs moved to Geistdocs, then onto `0311082`. The unpatched matrix component is byte-identical between `2069684` and `0311082`. On `0311082`, both frozen installs and the complete docs gate pass, including compatibility drift checking, TypeScript checking, the production build, 22 HTTP route tests, and all four browser contracts. The full native lanes have not been rerun on this base. Timings and screenshot comparisons above were not remeasured on the new docs stack.

The optimization loop stops after the two demonstrated, low-complexity wins. Remaining cost is mounting/layout of thousands of real table rows; a substantially different browsing or virtualization design would need a separate accessibility/UX decision rather than an unmeasured complexity increase. No rollout flag was added for this lifecycle-only patch, and no deployment was performed. Field checks remain pending: compare input-to-answer/interaction latency by build, browser, device class, and result cardinality under comparable conditions; verify labels, filtering, keyboard details, scrolling, and tooltip transitions alongside latency; use the authorized deployment/revert process if a regression appears.
