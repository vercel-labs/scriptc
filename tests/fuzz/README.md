# Fuzz targets

`main.ts` is one program with a subcommand per target. `scripts/fuzz.mjs` builds it with AddressSanitizer, the runtime's reference-count audit and UndefinedBehaviorSanitizer, replays every regression case, then fuzzes each target for a fixed time. The program also runs under Node, which is how a result is compared with Node's.

```bash
node scripts/fuzz.mjs                          # every target, 10 s each
node scripts/fuzz.mjs --targets=json,url --seconds=120 --seed=7
node scripts/fuzz.mjs --seconds=0              # regressions only
node scripts/fuzz.mjs --framing=60             # also compare request framing with Node for 60 s
```

It needs a built workspace (`pnpm build`), the platform's LLVM helper and runtime pack, and `clang` on `PATH`, as any `scriptc build --sanitize` does. Nothing here is part of a published package.

## Targets

<table>
<tr><th>Target</th><th>What it feeds</th></tr>
<tr><td><code>bytes</code></td><td>Buffer and text decoding: base64, base64url, hex, UTF-8, UTF-16, Latin-1, <code>StringDecoder</code>, <code>TextDecoder</code>, and Buffer reads, writes, copies and searches at arbitrary offsets</td></tr>
<tr><td><code>json</code></td><td><code>JSON.parse</code> into untyped values, typed records, arrays and unions, revivers, and <code>JSON.stringify</code></td></tr>
<tr><td><code>number</code></td><td>number parsing and formatting, <code>BigInt</code>, <code>util.format</code>, <code>util.inspect</code></td></tr>
<tr><td><code>path</code></td><td><code>node:path</code>, POSIX and Windows</td></tr>
<tr><td><code>regex</code></td><td>compiling patterns from data and matching with them</td></tr>
<tr><td><code>url</code></td><td>WHATWG <code>URL</code>, <code>URLSearchParams</code>, <code>url.parse</code>, <code>querystring</code>, percent coding, IDNA, file URLs</td></tr>
<tr><td><code>zlib</code></td><td>inflate, gunzip, raw inflate, brotli and zstd decompression of damaged streams</td></tr>
<tr><td><code>http-server</code></td><td>the HTTP/1 server: request heads, <code>Content-Length</code> and chunked bodies, trailers, pipelining, from a raw socket</td></tr>
<tr><td><code>http-client</code></td><td><code>http.get</code> and <code>fetch</code>: response heads, bodies, redirects and content codings, from a raw server; every request must settle</td></tr>
</table>

The first seven generate and run their cases inside the program. The last two are the program's HTTP server and client; `scripts/fuzz-http.mjs` holds the raw client and raw server that drive them.

## Cases, seeds and regressions

A case is a JSON list of strings in one file: the mode, a salt for the choices the case makes while it runs, then the target's fields (for the HTTP targets, the bytes on the wire as a Latin-1 string).

- `seeds/<target>/` is the seed corpus: well-formed inputs that generation mutates.
- `regressions/<target>/` holds cases that failed once. Every run replays them before it fuzzes, so they are permanent tests.

Every generated case depends only on the seed and its index. A pull request's run uses fixed seeds, so it fails only for what the pull request changed; the nightly run takes its seed from the date and prints it.

## When a run fails

A target fails when the program exits with a sanitizer report, a trap or a signal, when it runs out of time, when the HTTP server stops answering, or when a request of the HTTP client never settles. The driver writes the case that was running to `<out>/crashes/<target>-<n>.json` with the log beside it (`<out>` is `node_modules/.cache/scriptc-fuzz` unless `--out` says otherwise; the nightly job uploads it).

To replay a case (`fuzz` is `<out>/bin/fuzz`):

```bash
fuzz json replay case.json                                  # an in-process target
node tests/fuzz/main.ts json replay case.json               # the same case under Node
node scripts/fuzz-http.mjs serve case.json                  # http-client: prints "listening <port>", then
fuzz http-client <port> 0 6                                 # six requests: http.get and fetch, redirects followed and not
```

For `http-server`, the driver writes the last 32 requests it sent; copy them into `regressions/http-server/` and run `node scripts/fuzz.mjs --targets=http-server --seconds=0` to find the one that matters.

To keep a case as a test, copy its file into `regressions/<target>/` under a name that says what it is, and commit it with the fix.

## Comparing with Node

Each in-process target keeps a checksum of everything it observed and prints it at the end. The same command under Node prints the same checksum when the two agree on every result:

```bash
fuzz path fuzz tests/fuzz/seeds/path 1 0 20000
node tests/fuzz/main.ts path fuzz tests/fuzz/seeds/path 1 0 20000
```

With a trailing `c` both print the checksum after every case, so the first line that differs names the case; `v` prints each case before it runs and `d` every observed value. The lanes do not compare checksums: they catch memory errors, undefined behavior, hangs and crashes. A checksum that differs is a difference from Node to report.

## The framing differential

`--framing=<seconds>` sends the same damaged byte streams to the server under Node and to the compiled server and compares, per connection, the requests each delivered to its handler: method, target, version, header count, body length and trailer count. It fails when both deliver a request at the same position and the two differ, which is the disagreement request smuggling needs. Streams where one server stops earlier than the other are counted and written to `<out>/framing-stricter.json`. `tests/corpus/8968-http-request-framing.ts` pins the hand-written streams of this family in the differential test suite.
