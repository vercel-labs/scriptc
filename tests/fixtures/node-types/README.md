# node-types fixture

A project whose node_modules contains @types/node — the adoption path for
real-world Node/TypeScript projects. The vendored node_modules are COMMITTED
TEST DATA, pinned so the type surface (and therefore the pinned diagnostics)
never drifts with the registry:

- `@types/node` 24.13.3
- `undici-types` 7.18.2 (its dependency — declares the web-platform globals:
  fetch/Response/AbortSignal/ReadableStream/...)

What the fixture pins (see tests/harness/project-config.test.ts):

- `argv-env.ts` — the SUPPORTED process surface (argv, env) typed by
  @types/node lowers statically and the binary runs: with @types/node
  present, the shipped fallback declarations for `process`/`node:fs`/
  `console` stand down (their types come from @types/node), but the same
  members lower to the same libCalls, recognized by name + @types/node
  provenance.
- `fenced.ts` — surface @types/node DECLARES but scriptc does not lower
  (process.uptime, Buffer.from, setInterval) reports the SC2020-family
  fence naming @types/node, instead of typechecking its way into a broken
  binary — and never a raw "Cannot find name" error.
- `event-loop-metrics.ts` and `timeout-type.ts` — performance.eventLoopUtilization, monitorEventLoopDelay's IntervalHistogram and NodeJS.Timeout as declared types lower under @types/node exactly as under the fallback declarations.
- `source-import/` — an imported TypeScript source may use the `RequestInfo` global supplied by TypeScript's default DOM lib while scriptc adopts the project's @types/node declarations.

Projects WITHOUT @types/node (every other fixture and the whole corpus) keep
the shipped fallback declarations and behave exactly as before.
