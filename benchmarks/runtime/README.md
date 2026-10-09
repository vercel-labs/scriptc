# Runtime benchmarks

Application-shaped workloads for measuring the speed of compiled executables. Each workload is deterministic, generates its own input (or reads a generated file), and prints a summary that must match Node.js byte-for-byte before it is timed.

| Workload | Category | Exercises |
| --- | --- | --- |
| `json-records` | cpu | `JSON.stringify`, typed `JSON.parse`, Map aggregation |
| `regex-logs` | cpu | regex `exec` with groups, `test`, global `replace` |
| `ast-interp` | cpu | tokenizer, recursive-descent parser, class dispatch |
| `records-sort` | cpu | comparator sorts, group-by, `reduce`/`filter` |
| `template-render` | cpu | template literals, escaping, `map`/`join` |
| `functional-pipeline` | cpu | `filter`/`map`/`reduce`/`flatMap` chains, closures, small records |
| `async-pipeline` | cpu | `async`/`await`, `Promise.all` fan-out |
| `word-graph` | cpu | string-keyed Map/Set, BFS |
| `alloc-trees` | cpu | allocation-heavy trees, immutable object-spread updates |
| `numeric-kernels` | cpu | sieve, hashing, `number[][]` matmul, `Float64Array` |
| `validate-errors` | cpu | throw/catch on a fraction of inputs, small call chains |
| `csv-numbers` | cpu | `split`, `Number`, `parseInt`, `toFixed` |
| `log-lines` | cpu | 200k immediate `console.log`/`process.stdout.write` lines into the runner's pipe |
| `log-summary`, `inventory-report` | cpu | the multi-module applications from `benchmarks/builds`, on 300k-line inputs |
| `cli-config` | startup | a `deploy-plan` CLI: read a ~110 KB JSON manifest, validate, interpolate env values, order 80 services into dependency waves, print a summary |
| `http-api` | server | a `node:http` JSON API: routing, query parsing, a seeded catalog, per-cart state, typed JSON bodies, `ETag`/`If-None-Match`, auth and request-id headers |

Compare two checkouts (each with a built CLI and native artifacts for the host):

```console
$ pnpm bench:runtime --baseline=../scriptc-main --candidate=. --runs=15 --json=result.json
```

Without `--baseline`, the runner reports absolute medians. Baseline and candidate launches are interleaved, and each workload reports the median ratio with a bootstrap 95% confidence interval. `faster`/`slower` verdicts require the whole interval on one side of 1.0. A per-host lock serializes the timed phase so concurrent runs on one machine do not distort each other. Executables that time out or diverge from Node are reported, never timed. Use `--workloads=cli-config,http-api` to run a subset.

Node is timed in the same interleaved loop and every row reports candidate/Node; the summary prints the overall geomean and, when several categories ran, the geomean per category (`cpu`, `startup`, `server`). Node runs each `.ts` entry directly, so its times include type stripping and ESM detection, as a user running the TypeScript source would see.

## Workload kinds

Entries in `workloads.json` are process workloads unless they set `kind`.

Process workloads time whole launches (wall time, startup included). An optional `launches` count makes each sample the median of that many sequential launches; `cli-config` uses 20 so that a startup-dominated command (a few milliseconds compiled, tens of milliseconds under Node) is measured with low noise. Its table row is labeled `(per launch)`. On a heavily loaded macOS host, whole batches of launches can run several times slower (samples become bimodal), so judge startup changes on the Linux lane or a quiet machine.

Server workloads (`"kind": "server"`) run a listening program and a load client:

- The server binds `127.0.0.1` on port 0 and reports `PORT <n>` on stderr, the same protocol as `tests/harness/server.test.ts`.
- The runner then starts the workload's `client` script under the runner's Node. `clients/http-load.mjs` is the client for every server, Node and compiled alike, so the numbers differ only by server. It drives keep-alive HTTP/1.1 connections over loopback with one request in flight per connection (closed loop, no pipelining), spread across worker threads so that the client has CPU headroom.
- Each connection issues a fixed, seeded request sequence; mutable server state is partitioned per connection, so every response is a pure function of the connection and request index regardless of interleaving. A session runs an untimed warmup phase (which also opens the connections), a barrier, then the measured phase, and finally `POST /shutdown`, after which the server prints its totals and exits.
- Correctness compares four legs against Node byte-for-byte: server stdout, server stderr without the `PORT` line, server exit status, and client stdout (request and status counts plus a SHA-256 digest over every response's status, `content-type`, `cache-control`, `etag`, `x-request-id`, and body). Framing (`content-length` or chunked) and `date` are not compared.
- The timed sample is the measured-phase wall time for the fixed request count, so the main table, ratios, and confidence intervals read exactly like other rows (lower is better); the row is labeled `(server)`. A second table reports median requests per second, p50/p90/p99 latency, client CPU cores used during the measured phase, and peak RSS for Node and each contender. Client cores near the client's thread count mean the client, not the server, limits throughput.
- Server sessions already warm up in-process, so the runner uses at most one extra warmup session per contender.

`http-api` uses 64 connections, 2 client threads, 4,000 warmup and 40,000 measured requests (about one second per session).
