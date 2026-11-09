# Runtime benchmarks

Application-shaped workloads for measuring the speed of compiled executables. Each workload is deterministic, generates its own input (or reads a generated file), and prints a summary that must match Node.js byte-for-byte before it is timed.

| Workload | Category | Exercises |
| --- | --- | --- |
| `alloc-trees` | cpu | allocation-heavy trees, immutable object-spread updates |
| `ast-interp` | cpu | tokenizer, recursive-descent parser, class dispatch |
| `async-pipeline` | cpu | `async`/`await`, `Promise.all` fan-out |
| `atomics-contended` | cpu | four worker threads updating `SharedArrayBuffer` counters with `Atomics`: one shared counter, one counter per worker, a `compareExchange` loop, and `Atomics.wait`/`notify` handoffs |
| `catalog-tables` | cpu | keyed tables made from keyed tables: `Object.values` over dictionaries of `object` from parsed JSON, flattened with `flatMap`, filtered by a field and keyed again with `Object.fromEntries` |
| `channel-messages` | cpu | 200,000 MessageChannel messages in one thread, half numbers and half small objects, all posted before the port delivers any |
| `class-unions` | cpu | class instances in unions with their base class (`Shape \| Circle \| Rect`, `Account \| Savings`): an array scanned through overridden methods and methods that return `this`, a `Map` of accounts, and `instanceof` tests for subclass members |
| `csv-numbers` | cpu | `split`, `Number`, `parseInt`, `toFixed` |
| `date-math` | cpu | schedules built with Date setters (local and UTC), weekday and month-end rules through the getters, Dates sorted by time value |
| `cyclic-graphs` | cpu | object graphs with back references built and dropped: trees with parent and sibling links, rings of records sharing a long-lived registry, closures capturing their owner |
| `dictionary-walks` | cpu | `Record<string, number>` dictionaries walked with for-in and `Object.keys`/`values`/`entries` while entries are added, updated and deleted |
| `dynamic-class-tests` | cpu | untyped JavaScript in a program with 240 classes, using constructors it holds in variables: `value instanceof ctor` against class values and builtin constructors, `new ctor()` from a list of classes, and deep copies of plain records with computed-key reads; none of it depends on the number of classes, so the time shows a class dispatch that walks them |
| `dynamic-methods` | cpu | untyped JavaScript calling builtin methods on values it does not type: string `slice`/`indexOf`/`toUpperCase`/`padStart`, array `push`/`pop`/`includes`, `Map` and `Set`, and an object's own methods |
| `dynamic-properties` | cpu | untyped JavaScript reading and writing properties of values it does not type: records built by object literals in two key orders, nested records, and instances of a class and its subclass |
| `functional-pipeline` | cpu | `filter`/`map`/`reduce`/`flatMap` chains, closures, small records |
| `handler-tables` | cpu | dispatch tables of functions: `Record<string, fn>` read as `t[k]!(…)`, `t[k]?.(…)` and through a checked local, a `Map<string, fn>`, an array of handlers, and an object literal of methods; some handlers declare fewer parameters than the table type |
| `intern-table`, `intern-table-map`, `intern-table-1`, `intern-table-map-1` | cpu | worker threads interning the same type-like objects under string keys and records under number keys, then hits and misses: one shared `InternTable` per kind of key, or a module-level `Map` per thread (the `-map` entries), with 8 threads or 1 (the `-1` entries); under Node.js every thread has its own tables |
| `json-records` | cpu | `JSON.stringify`, typed `JSON.parse`, Map aggregation |
| `json-unions` | cpu | `JSON.parse` into discriminated unions: an event log with eight kinds and nested expression trees with nine, evaluated after the cast |
| `keyed-option-writes` | cpu | class methods whose names are also keys of option records written through element accesses: `enabled[name] = true` over a union of literal names and `totals["count"] = n` |
| `layered-errors` | cpu | validation errors thrown below a stack of small functions that hold strings and arrays, and caught per entry in a loop: about half of 640,000 entries fail |
| `line-reader` | cpu | `readline` over a file stream: 'line' events for a 67 MB access log (every 50th line not ASCII), with a status count, a path tally and byte totals |
| `log-lines` | cpu | 200k immediate `console.log`/`process.stdout.write` lines into the runner's pipe |
| `log-summary`, `inventory-report` | cpu | the multi-module applications from `benchmarks/builds`, on 300k-line inputs |
| `module-table-reads` | cpu | reads of a number table that another module builds at load (`benchmarks/runtime/module-table`): a hundred million through that module's one-line accessor from the entry's loop, and as many in a loop of the module's own. The table's module only computes, so its initializer runs at the first read; the workload is the cost of the check in front of a read |
| `n-body` | cpu | five planets in an array of records advanced a million fixed steps by the pair loop over the upper triangle, then the system's total energy before and after |
| `number-maps` | cpu | number-keyed Map/Set: a dense-id table, sparse ids in many small maps, get/has/set mixes |
| `numeric-kernels` | cpu | sieve, hashing, `number[][]` matmul, `Float64Array` |
| `optional-child-sets` | cpu | syntax-tree walks through class nodes whose getters return `TreeNode \| undefined` children, in a program that also keeps a `Set<TreeNode \| undefined>` |
| `optional-fields` | cpu | records and class instances with `number \| undefined` and other scalar-union fields |
| `published-graphs` | cpu | syntax trees with parent links and a symbol table, published with `@scriptc/threads` and then read |
| `record-untyped-writes` | cpu | typed records written through untyped views: a counter helper taking `unknown` bumps fields of a stats record, and `Object.assign` merges patches into a settings record, with typed reads in between |
| `record-boundaries` | cpu | records built from unchecked array reads passed to and returned from annotated functions |
| `untyped-handoff` | cpu | typed records stored as `unknown` beside the function that declared their type and handed back to it: annotated, `satisfies`, a parameter typed by the reader's own parameter, and a bare literal read with `as` |
| `records-sort` | cpu | comparator sorts, group-by, `reduce`/`filter` |
| `regex-logs` | cpu | regex `exec` with groups, `test`, global `replace` |
| `regex-replacers` | cpu | regex `replace`/`replaceAll` with inline callbacks whose parameters have no annotations: dictionary placeholders, snake_case to camelCase, date reordering, optional captures, capitalization, and a string search that reads the offset |
| `regex-tokenizer` | cpu | a block tokenizer in the shape Markdown parsers have: twelve rules anchored at the start (`/^…/`) tried in order on the rest of a document, each token cut off with `slice`; three generated documents of about 60,000 characters (ASCII, with dashes and accented letters, with emoji) |
| `region-builds` | cpu | a watch-mode build loop over `LifetimeRegion`: each build binds a program in a new region and releases the previous one, which a cache keeps referenced for two builds |
| `string-iteration` | cpu | code point iteration over text that mixes ASCII, Latin-1 letters, CJK and emoji: a for-of word tokenizer, spread reversal, and `Array.from` over words |
| `template-render` | cpu | template literals, escaping, `map`/`join` |
| `throw-chains` | cpu | exceptions caught 2, 5 and 20 recursive calls above the throw, through direct calls and through a callback, and a backtracking parser that throws on a failed alternative |
| `thread-slots`, `thread-slots-cache` | cpu | worker threads reading one published type graph from an `InternTable` and keeping per-thread state for each type they visit: a `ThreadSlots` family, or a direct-mapped cache by id in front of a `Map` by id (the `-cache` entry); under Node.js both are per thread |
| `typed-array-convert` | cpu | copies from one typed view into another: construction from a view of the same kind, `set()` into a preallocated destination through the widening, narrowing and float conversions, and views that start at a non-zero byte offset |
| `typed-array-kernels` | cpu | element-wise loops that run to one typed array's length and index others at the same position: `Float64Array` axpy, `Float32Array` blend, `Uint8Array` mask, wrapping `Int32Array` add, `Uint8ClampedArray` brighten, RGBA to gray, a row-major `Float32Array` matrix-vector product, and `reduce`/`some`/`map` callbacks |
| `typed-array-scan`, `typed-array-scan-workers` | cpu | element-by-element scan loops over `Uint8Array`, `Uint16Array`, `Int32Array` and `Float64Array`; the second entry is a worker-enabled executable (it can start a worker), so each access also checks for shared storage |
| `unicode-lexer` | cpu | a hand-written lexer over a 2.7M-unit bundled module whose comments and strings are in several languages: `charCodeAt` scans, line starts |
| `union-node-sets` | cpu | syntax-tree passes over a discriminated union of object literals: a `Set` of visited nodes, a `Map` from node to value, conversions to a sub-union of leaves |
| `untyped-record-probes` | cpu | typed records and arrays printed by a walker that takes `unknown`: `typeof`, `Array.isArray`, reads of members no record has (a hook, a flag, `then`), `in`, a for-in guarded by `hasOwnProperty`, and keyed reads of the fields it prints |
| `validate-errors` | cpu | throw/catch on a fraction of inputs, small call chains |
| `value-objects` | cpu | small immutable records and class instances: vector helpers, method chains, particle updates |
| `value-records` | cpu | records that hold strings, spread state updates and destructured tuples: token helpers, an immutable reducer, tuple returns |
| `word-graph` | cpu | string-keyed Map/Set, BFS |
| `worker-messages` | cpu | message round trips between the main thread and one worker: each posts a number and the other answers it, so every round trip is two messages and two wakeups of a waiting thread |
| `cli-config` | startup | a `deploy-plan` CLI: read a ~110 KB JSON manifest, validate, interpolate env values, order 80 services into dependency waves, print a summary |
| `startup-islands-used`, `startup-islands-unused`, `startup-islands-cold` | startup | a command-line program with three dependencies in Node islands (`benchmarks/startup/islands`): an ES module package of about a hundred small modules, a CommonJS package whose load reads an environment variable that is normally unset, and a package it imports and does not use, which ships 1.3 MB of data files nothing loads (as most of a real package directory is). `-used` calls into the first two; `-unused` prints a version and uses none of them, so its time is what having islands costs a start that does not need them; `-cold` is `-used` on a first run, with an empty island module cache. All three need a libnode pack |
| `startup-modules` | startup | the 240-module program in `benchmarks/startup/modules`: every module's top level runs (classes and instances, Maps and a shared registry filled at load, record tables, strings and regex literals, a regular expression built from a string, constant objects, closures) and the entry prints one line, so the time is module initialization |
| `startup-unused-tables` | startup | the command-line tool in `benchmarks/startup/unused`, asked for its version: four modules build tables at load (number tables filled by loops, records derived from a smaller table, a catalogue flattened with `Object.entries` and `flatMap`, regular expressions assembled from strings) and the command reads none of them, so the time is what unused module-level tables cost a start |
| `http-api` | server | a `node:http` JSON API: routing, query parsing, a seeded catalog, per-cart state, typed JSON bodies, `ETag`/`If-None-Match`, auth and request-id headers |

Compare two checkouts (each with a built CLI and native artifacts for the host):

```console
$ pnpm bench:runtime --baseline=../scriptc-main --candidate=. --runs=15 --json=result.json
```

Without `--baseline`, the runner reports absolute medians. Baseline and candidate launches are interleaved, and each workload reports the median ratio with a bootstrap 95% confidence interval. `faster`/`slower` verdicts require the whole interval on one side of 1.0. A per-host lock serializes the timed phase so concurrent runs on one machine do not distort each other. Executables that time out or diverge from Node are reported, never timed. Use `--workloads=cli-config,http-api` to run a subset.

Node is timed in the same interleaved loop and every row reports candidate/Node; the summary prints the overall geomean and, when several categories ran, the geomean per category (`cpu`, `startup`, `server`). Node runs each `.ts` entry directly, so its times include type stripping and ESM detection, as a user running the TypeScript source would see.

## Steady-state ratios

Every timed sample is a whole launch, so candidate/Node includes process start-up: tens of milliseconds for Node (which also strips types and compiles the module) and about one for a compiled executable. For a workload that runs for 30 ms compiled, most of that ratio is start-up, and it says little about the speed of the code.

`--steady=<factor>` adds a second ratio beside it:

```console
$ pnpm bench:runtime --candidate=. --steady=4 --json=result.json
```

A workload file names the argument that multiplies the workload's work with `"scaleArg"`, the argument's index in `args`. With `--steady=4` the runner also times the candidate and Node with that argument multiplied by 4 (`--steady-runs` launches each, 5 by default) and reports the candidate's extra time over Node's extra time: (time at 4x − time at 1x) for the candidate, divided by the same difference for Node. Start-up and most of the JIT's warm-up are in both times of each difference and cancel. The extra work need not be exactly 3 times the original, only the same for both.

The existing columns and JSON fields are unchanged. The table gains a `steady candidate/node` column, each workload's JSON entry a `steady` object (`factor`, `args`, `candidate_ms` and `node_ms` at the scaled size, `candidate_marginal_ms`, `node_marginal_ms`, `vs_node`, and its bootstrap `ci95`), and the summary the geomean of the steady ratios next to the whole-process geomean over the same workloads. The scaled output is compared with Node's first; a difference is reported as `mismatch` and fails the run. A workload that times out at the scaled size, or whose time does not grow for both, has no steady ratio (`timeout`, `no-growth`). Startup-bound and server workloads, and workloads without `scaleArg`, have none either.

## Workload kinds

Each workload is a JSON file in `workloads/`, named after the workload, that holds its `entry`, `args` and options (`scaleArg` among them, when one argument scales the work); adding a workload adds its file and its row in the table above, kept in category and then name order. Workloads are process workloads unless they set `kind`.

A workload that needs more than a built checkout says so in `requires`. The one value is `"libnode"`: the program has Node islands, so its executables load a libnode pack from `SCRIPTC_LIBNODE`. Without that variable the runner leaves the workload out and says so, and the zero-cost gate leaves it out on both sides. With it, the runner gives every launch an island module cache of its own run (`XDG_CACHE_HOME` in its work directory): each contender's first launch, the one compared with Node, installs the modules, and the timed launches find them installed. A workload with `"cache": "cold"` times the first launch instead: each of its launches gets an empty cache directory. The JSON report lists the workloads that were left out under `skipped`, with the reason.

Process workloads time whole launches (wall time, startup included). An optional `launches` count makes each sample the median of that many sequential launches; `cli-config` and `startup-modules` use 20 so that a startup-dominated command (a few milliseconds compiled, tens of milliseconds under Node) is measured with low noise. Their table rows are labeled `(per launch)`. On a heavily loaded macOS host, whole batches of launches can run several times slower (samples become bimodal), so judge startup changes on the Linux lane or a quiet machine.

Server workloads (`"kind": "server"`) run a listening program and a load client:

- The server binds `127.0.0.1` on port 0 and reports `PORT <n>` on stderr, the same protocol as `tests/harness/server.test.ts`.
- The runner then starts the workload's `client` script under the runner's Node. `clients/http-load.mjs` is the client for every server, Node and compiled alike, so the numbers differ only by server. It drives keep-alive HTTP/1.1 connections over loopback with one request in flight per connection (closed loop, no pipelining), spread across worker threads so that the client has CPU headroom.
- Each connection issues a fixed, seeded request sequence; mutable server state is partitioned per connection, so every response is a pure function of the connection and request index regardless of interleaving. A session runs an untimed warmup phase (which also opens the connections), a barrier, then the measured phase, and finally `POST /shutdown`, after which the server prints its totals and exits.
- Correctness compares four legs against Node byte-for-byte: server stdout, server stderr without the `PORT` line, server exit status, and client stdout (request and status counts plus a SHA-256 digest over every response's status, `content-type`, `cache-control`, `etag`, `x-request-id`, and body). Framing (`content-length` or chunked) and `date` are not compared.
- The timed sample is the measured-phase wall time for the fixed request count, so the main table, ratios, and confidence intervals read exactly like other rows (lower is better); the row is labeled `(server)`. A second table reports median requests per second, p50/p90/p99 latency, client CPU cores used during the measured phase, and peak RSS for Node and each contender. Client cores near the client's thread count mean the client, not the server, limits throughput.
- Server sessions already warm up in-process, so the runner uses at most one extra warmup session per contender.

`http-api` uses 64 connections, 2 client threads, 4,000 warmup and 40,000 measured requests (about one second per session).
