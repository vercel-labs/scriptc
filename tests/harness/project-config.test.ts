/* Project adoption: the tsconfig.json governing the ENTRY decides checker
 * strictness (the adopted knobs), while lib/module/target stay forced —
 * see the compiler-options split in frontend/program.ts and SEMANTICS.md.
 * The strictness fixtures compile the SAME program under two tsconfigs and
 * pin both directions; the null-floor fixture pins the strictNullChecks
 * floor diagnostic; the node-types fixture (vendored, pinned @types/node —
 * see its README) pins the @types/node adoption path: the supported
 * process surface still lowers statically, and everything else @types/node
 * declares fences with the SC2020-family wording that names it.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { analyze, compile, renderDiagnostics } from "@scriptc/compiler";

/* Every compile below deliberately carries NO backend pin: this suite is
 * the user-adoption path, so it must see exactly what a flagless
 * `scriptc build` produces through the production LLVM backend. */
const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = (name: string) => join(repoRoot, "tests/fixtures/strictness", name);
const nodeTypesDir = join(repoRoot, "tests/fixtures/node-types");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

function comparableStderr(text: string): string {
  return sanitize
    ? text.replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      )
    : text;
}

test("node-types: filesystem capacity supports typed number and BigInt results under @types/node", async () => {
  const outDir = outDirFor("fs-statfs");
  const entry = join(nodeTypesDir, "fs-statfs.ts");
  const result = await compile(entry, {
    outPath: join(outDir, process.platform === "win32" ? "fs-statfs.exe" : "fs-statfs"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: Headers, Request and Response members typed by undici-types run natively", async () => {
  const outDir = outDirFor("fetch-handle-members");
  const entry = join(nodeTypesDir, "fetch-handle-members.ts");
  const result = await compile(entry, {
    outPath: join(
      outDir,
      process.platform === "win32" ? "fetch-handle-members.exe" : "fetch-handle-members",
    ),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: fetch's string | URL | Request input and a custom fetch cast to typeof fetch", async () => {
  const outDir = outDirFor("fetch-input-unions");
  const entry = join(nodeTypesDir, "fetch-input-unions.ts");
  const result = await compile(entry, {
    outPath: join(
      outDir,
      process.platform === "win32" ? "fetch-input-unions.exe" : "fetch-input-unions",
    ),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

for (const [name, title] of [
  [
    "event-loop-metrics",
    "eventLoopUtilization and monitorEventLoopDelay follow @types/node's types",
  ],
  ["timeout-type", "NodeJS.Timeout fields, ref/unref/hasRef and clearInterval under @types/node"],
  ["x509-methods", "X509Certificate's methods and the legacy object under @types/node"],
  ["tls-peer-certificates", "TLS socket certificate accessors under @types/node"],
  ["tls-client-certificates", "mutual TLS with client certificates under @types/node"],
  [
    "tls-server-contexts",
    "tls.Server addContext, setSecureContext and tlsClientError under @types/node",
  ],
] as const) {
  test(`node-types: ${title}`, async () => {
    const outDir = outDirFor(name);
    const entry = join(nodeTypesDir, `${name}.ts`);
    const result = await compile(entry, {
      outPath: join(outDir, process.platform === "win32" ? `${name}.exe` : name),
      outDir,
      sanitize,
    });
    expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
    if (!result.ok) return;
    const [native, node] = await Promise.all([
      execFileAsync(result.binaryPath),
      execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
    ]);
    expect(native.stdout).toBe(node.stdout);
    expect(comparableStderr(native.stderr)).toBe(node.stderr);
  });
}

test("node-types: http header arrays and server.address() follow @types/node's types", async () => {
  const outDir = outDirFor("http-headers-address");
  const entry = join(nodeTypesDir, "http-headers-address.ts");
  const result = await compile(entry, {
    outPath: join(
      outDir,
      process.platform === "win32" ? "http-headers-address.exe" : "http-headers-address",
    ),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: filesystem links accept URL and Buffer paths and typed readlink results under @types/node", async () => {
  const outDir = outDirFor("fs-links");
  const entry = join(nodeTypesDir, "fs-links.ts");
  const result = await compile(entry, {
    outPath: join(outDir, process.platform === "win32" ? "fs-links.exe" : "fs-links"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: filesystem timestamps accept Date, Buffer, URL, and FileHandle inputs under @types/node", async () => {
  const outDir = outDirFor("fs-timestamps");
  const entry = join(nodeTypesDir, "fs-timestamps.ts");
  const result = await compile(entry, { outPath: join(outDir, "fs-timestamps"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: ESM metadata supports computed and destructured reads under @types/node", async () => {
  const outDir = outDirFor("esm-metadata");
  const entry = join(nodeTypesDir, "esm-metadata.mts");
  const result = await compile(entry, { outPath: join(outDir, "esm-metadata"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, [entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: util.types supports native brands and predicate narrowing under @types/node", async () => {
  const outDir = outDirFor("util-types");
  const entry = join(nodeTypesDir, "util-types.ts");
  const result = await compile(entry, { outPath: join(outDir, "util-types"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: util.styleText supports stored calls and standard streams under @types/node", async () => {
  const outDir = outDirFor("style-text");
  const entry = join(nodeTypesDir, "style-text.ts");
  const result = await compile(entry, { outPath: join(outDir, "style-text"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: dgram socket options under @types/node", async () => {
  const outDir = outDirFor("dgram-options");
  const entry = join(nodeTypesDir, "dgram-options.ts");
  const result = await compile(entry, {
    outPath: join(outDir, process.platform === "win32" ? "dgram-options.exe" : "dgram-options"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: events.once over typed EventEmitter listeners under @types/node", async () => {
  const outDir = outDirFor("events-once");
  const entry = join(nodeTypesDir, "events-once.ts");
  const result = await compile(entry, { outPath: join(outDir, "events-once"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: events.once with a signal over streams, raced, under @types/node", async () => {
  const outDir = outDirFor("events-once-signal-race");
  const entry = join(nodeTypesDir, "events-once-signal-race.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "events-once-signal-race"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: socket.address and resetAndDestroy under @types/node", async () => {
  const outDir = outDirFor("net-reset-address");
  const entry = join(nodeTypesDir, "net-reset-address.ts");
  const result = await compile(entry, {
    outPath: join(
      outDir,
      process.platform === "win32" ? "net-reset-address.exe" : "net-reset-address",
    ),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: TLSSocket.isSessionReused and keyed ??= timings under @types/node", async () => {
  const outDir = outDirFor("tls-session-timings");
  const entry = join(nodeTypesDir, "tls-session-timings.ts");
  const result = await compile(entry, {
    outPath: join(
      outDir,
      process.platform === "win32" ? "tls-session-timings.exe" : "tls-session-timings",
    ),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: new tls.TLSSocket and tls.connect({ socket }) under @types/node", async () => {
  const outDir = outDirFor("tls-socket-wrap");
  const entry = join(nodeTypesDir, "tls-socket-wrap.ts");
  const result = await compile(entry, {
    outPath: join(outDir, process.platform === "win32" ? "tls-socket-wrap.exe" : "tls-socket-wrap"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: net.SocketAddress and net.BlockList under @types/node", async () => {
  const outDir = outDirFor("net-blocklist");
  const entry = join(nodeTypesDir, "net-blocklist.ts");
  const result = await compile(entry, {
    outPath: join(outDir, process.platform === "win32" ? "net-blocklist.exe" : "net-blocklist"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: timers/promises resolve values and setInterval iteration under @types/node", async () => {
  const outDir = outDirFor("timers-promises");
  const entry = join(nodeTypesDir, "timers-promises.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "timers-promises"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: readline/promises over stdin compiles under @types/node", async () => {
  const outDir = outDirFor("readline-promises");
  const entry = join(nodeTypesDir, "readline-promises.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "readline-promises"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

function outDirFor(name: string): string {
  return mkdtempSync(join(tmpdir(), `scriptc-config-${name}-`));
}

test("indexed-loose: the project's own (less strict) knobs are adopted — compiles and runs", async () => {
  const outDir = outDirFor("loose");
  const result = await compile(join(fixture("indexed-loose"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("21\n");
});

test("indexed-strict: the project's EXTRA strictness is honored — preflight fails", async () => {
  const outDir = outDirFor("strict");
  const result = await compile(join(fixture("indexed-strict"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The SAME program compiles in indexed-loose; only the tsconfig differs.
  expect(result.diagnostics.map((d) => d.code)).toContain("SC0001");
  expect(result.diagnostics.some((d) => d.message.includes("possibly 'undefined'"))).toBe(true);
});

test("project paths: TS 7 checking and native module lowering share the configured aliases", async () => {
  const outDir = outDirFor("project-paths");
  const result = await compile(join(fixture("project-paths"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("paths agree 42\n");
});

test("node-types: the supported process surface lowers statically under @types/node", async () => {
  const outDir = outDirFor("node-types");
  const result = await compile(join(nodeTypesDir, "argv-env.ts"), {
    outPath: join(outDir, "argv-env"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath, ["alpha", "beta"], {
    env: { ...process.env, SCRIPTC_FIXTURE_GREETING: "hi from env" },
  });
  // argv[0] is the binary path (machine-dependent) — the program prints
  // only the count and argv[1..], then exercises the raw stdout write.
  expect(stdout).toBe("2\nalpha\nbeta\nhi from env\nwritten without newline <- flushed in order\n");
});

test("node-types: URL port and hash getters lower statically under @types/node", async () => {
  const outDir = outDirFor("node-url-getters");
  const entry = join(nodeTypesDir, "url-getters.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "url-getters"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, [entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: captured NodeJS.WritableStream values write through the procStream scalar", async () => {
  const outDir = outDirFor("node-stream-capture");
  const result = await compile(join(nodeTypesDir, "stream-capture.ts"), {
    outPath: join(outDir, "stream-capture"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("[out] line\n[out] line\ndone\n");
  expect(comparableStderr(stderr)).toBe("[err] line\n");
});

test("node-types: refined spawn returns expose writable child stdin", async () => {
  const dir = outDirFor("node-child-stdin");
  const entry = join(nodeTypesDir, "child-stdin.ts");
  const result = await compile(entry, {
    outPath: join(dir, "child-stdin"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("typed child stdin\n");
});

test("node-types: callback execFile uses the typed error-first overload", async () => {
  const dir = outDirFor("node-child-execfile");
  const entry = join(nodeTypesDir, "child-execfile.ts");
  const result = await compile(entry, {
    outPath: join(dir, "child-execfile"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("typed-execfile true\n");
});

test("node-types: promisified exec and execFile results under PromiseWithChild", async () => {
  const dir = outDirFor("node-child-promisify-exec");
  const entry = join(nodeTypesDir, "child-promisify-exec.ts");
  const result = await compile(entry, {
    outPath: join(dir, "child-promisify-exec"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe('typed-exec err typed-execfile true\n"Command failed: exit 2\\n"\n');
  expect(stderr).toBe("");
});

test("node-types: promisified fs callback functions lower as their fs/promises calls", async () => {
  const outDir = outDirFor("promisify-fs");
  const entry = join(nodeTypesDir, "promisify-fs.ts");
  const result = await compile(entry, { outPath: join(outDir, "promisify-fs"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: util.promisify over typed callback-last functions settles like Node", async () => {
  const outDir = outDirFor("promisify-callback-functions");
  const entry = join(nodeTypesDir, "promisify-callback-functions.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "promisify-callback-functions"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: lookup-option unions and narrowed header-record entries under @types/node", async () => {
  const outDir = outDirFor("lookup-and-header-entries");
  const entry = join(nodeTypesDir, "lookup-and-header-entries.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "lookup-and-header-entries"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const native = await execFileAsync(result.binaryPath);
  const node = await execFileAsync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    entry,
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: http.request over a Unix socket with RequestOptions read at run time", async () => {
  const outDir = outDirFor("http-socket-path");
  const entry = join(nodeTypesDir, "http-socket-path.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "http-socket-path"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const native = await execFileAsync(result.binaryPath);
  const node = await execFileAsync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    entry,
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: RequestInit-derived options carry BodyInit and HeadersInit into fetch", async () => {
  const outDir = outDirFor("fetch-init-members");
  const entry = join(nodeTypesDir, "fetch-init-members.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "fetch-init-members"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const native = await execFileAsync(result.binaryPath);
  const node = await execFileAsync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    entry,
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: stream subclasses extend the @types/node stream classes", async () => {
  const outDir = outDirFor("stream-subclass-hooks");
  const entry = join(nodeTypesDir, "stream-subclass-hooks.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "stream-subclass-hooks"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: NodeJS stream interfaces and stream.Readable/Writable take every stream producer", async () => {
  const outDir = outDirFor("node-stream-interfaces");
  const entry = join(nodeTypesDir, "node-stream-interfaces.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "node-stream-interfaces"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: streams construct and child listeners take @types/node's parameter types", async () => {
  const outDir = outDirFor("stream-construction");
  const entry = join(nodeTypesDir, "stream-construction.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "stream-construction"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: promisified setTimeout and setImmediate lower as timers/promises", async () => {
  const outDir = outDirFor("promisify-timers");
  const entry = join(nodeTypesDir, "promisify-timers.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "promisify-timers"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: promisified zlib one-shots settle from the worker-pool codec", async () => {
  const outDir = outDirFor("promisify-zlib");
  const entry = join(nodeTypesDir, "promisify-zlib.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "promisify-zlib"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: promisified crypto callback functions settle with the callback value", async () => {
  const outDir = outDirFor("promisify-crypto");
  const entry = join(nodeTypesDir, "promisify-crypto.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "promisify-crypto"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: promisified dns lookups settle with the lookup objects", async () => {
  const outDir = outDirFor("promisify-dns");
  const entry = join(nodeTypesDir, "promisify-dns.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "promisify-dns"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: child stdin forms beyond write(string) compile through the general stream representation", async () => {
  const dir = outDirFor("node-child-stdin-streams");
  const entry = join(nodeTypesDir, "child-stdin-streams.ts");
  const result = await compile(entry, {
    outPath: join(dir, "child-stdin-streams"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: callback exec uses the typed ExecException overloads", async () => {
  const dir = outDirFor("node-child-exec");
  const entry = join(nodeTypesDir, "child-exec.ts");
  const result = await compile(entry, {
    outPath: join(dir, "child-exec"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe('typed-exec err\n"Command failed: exit 2\\n"\n');
});

test("node-types: exec's numeric ExecException.code remains a named fence", async () => {
  const dir = outDirFor("node-child-exec-code-fences");
  const entry = join(nodeTypesDir, "child-exec-code-fences.ts");
  const result = await compile(entry, {
    outPath: join(dir, "child-exec-code-fences"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "SC2020",
    "SC2020",
    "SC2020",
  ]);
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.message).toContain("ExecException.code");
  }
});

test("node-types: fs functions take URL paths under @types/node's PathLike", async () => {
  const dir = outDirFor("node-fs-url-paths");
  const result = await compile(join(nodeTypesDir, "fs-url-paths.ts"), {
    outPath: join(dir, "fs-url-paths"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("hello 5 5\n");
});

test("node-types: existsSync and fs.promises answer false or reject for unconvertible URLs", async () => {
  const dir = outDirFor("node-fs-url-fallible");
  const result = await compile(join(nodeTypesDir, "fs-url-fallible.ts"), {
    outPath: join(dir, "fs-url-fallible"),
    outDir: dir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("true false\nhi\nERR_INVALID_FILE_URL_HOST\n");
});

test("node-types: path and os lower statically under @types/node's shapes", async () => {
  const outDir = outDirFor("node-path-os");
  const result = await compile(join(nodeTypesDir, "path-os.ts"), {
    outPath: join(outDir, "path-os"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("b/c.txt\n/x/y z .gz\ntrue /\ntrue true\ntrue true true true true\ntrue\n");
});

test("node-types: fetch AbortSignal and readable bodies lower statically", async () => {
  const outDir = outDirFor("node-fetch-static");
  const result = await compile(join(nodeTypesDir, "fetch-static.ts"), {
    outPath: join(outDir, "fetch-static"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
});

test("node-types: imported TypeScript sources can use the RequestInfo global", async () => {
  const entry = join(nodeTypesDir, "source-import/main.ts");
  expect(analyze(entry).coverage.preflightFailed).toBe(false);
  const outDir = outDirFor("request-info");
  const result = await compile(entry, {
    outPath: join(outDir, "request-info"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, [entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: global and node:util codec instances share the stored native representation", async () => {
  const entry = join(nodeTypesDir, "text-codecs.mts");
  const outDir = outDirFor("text-codecs");
  const result = await compile(entry, {
    outPath: join(outDir, "text-codecs"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, [entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: imported console methods share native output formatting", async () => {
  const entry = join(nodeTypesDir, "console-imports.mts");
  const outDir = outDirFor("console-imports");
  const result = await compile(entry, {
    outPath: join(outDir, "console-imports"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, [entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: crypto key derivation and SHA-2 match Node under @types/node", async () => {
  const outDir = outDirFor("node-crypto-kdf");
  const entry = join(nodeTypesDir, "crypto-kdf.ts");
  const result = await compile(entry, { outPath: join(outDir, "crypto-kdf"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: URL mutation matches Node under @types/node", async () => {
  const outDir = outDirFor("node-url-mutation");
  const entry = join(nodeTypesDir, "url-mutation.ts");
  const result = await compile(entry, { outPath: join(outDir, "url-mutation"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: URL factories match Node under @types/node", async () => {
  const outDir = outDirFor("node-url-factories");
  const entry = join(nodeTypesDir, "url-factories.ts");
  const result = await compile(entry, { outPath: join(outDir, "url-factories"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: the legacy url API matches Node under @types/node", async () => {
  const outDir = outDirFor("node-url-legacy");
  const entry = join(nodeTypesDir, "url-legacy.ts");
  const result = await compile(entry, { outPath: join(outDir, "url-legacy"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  // The DEP0169 report names each process's own pid.
  const withoutPid = (text: string): string => text.replace(/^\(node:\d+\) /gm, "(node:pid) ");
  expect(withoutPid(comparableStderr(native.stderr))).toBe(withoutPid(node.stderr));
  expect(node.stderr).toContain("[DEP0169] DeprecationWarning");
});

test("node-types: no-error assertions match Node under @types/node", async () => {
  const outDir = outDirFor("node-no-error-assertions");
  const entry = join(nodeTypesDir, "no-error-assertions.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "no-error-assertions"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: text utilities match Node under @types/node", async () => {
  const outDir = outDirFor("node-text-utilities");
  const entry = join(nodeTypesDir, "text-utilities.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "text-utilities"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: system error utilities match Node under @types/node", async () => {
  const outDir = outDirFor("node-system-errors");
  const entry = join(nodeTypesDir, "system-errors.ts");
  const result = await compile(entry, { outPath: join(outDir, "system-errors"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: deep equality matches Node under @types/node", async () => {
  const outDir = outDirFor("node-deep-equality");
  const entry = join(nodeTypesDir, "deep-equality.ts");
  const result = await compile(entry, { outPath: join(outDir, "deep-equality"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: file URL conversions match Node under @types/node", async () => {
  const outDir = outDirFor("node-file-url-conversion");
  const entry = join(nodeTypesDir, "file-url-conversion.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "file-url-conversion"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: environment-file APIs match Node under @types/node", async () => {
  const outDir = outDirFor("node-env-files");
  const entry = join(nodeTypesDir, "env-files.ts");
  const result = await compile(entry, { outPath: join(outDir, "env-files"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: text encoding APIs match Node under @types/node", async () => {
  const outDir = outDirFor("node-text-encoding");
  const entry = join(nodeTypesDir, "text-encoding.ts");
  const result = await compile(entry, { outPath: join(outDir, "text-encoding"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: Blob and File match Node under @types/node", async () => {
  const outDir = outDirFor("node-blob-file");
  const entry = join(nodeTypesDir, "blob-file.ts");
  const result = await compile(entry, { outPath: join(outDir, "blob-file"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: fs.glob forms match Node under @types/node", async () => {
  const outDir = outDirFor("node-fs-glob");
  const entry = join(nodeTypesDir, "fs-glob.ts");
  const result = await compile(entry, { outPath: join(outDir, "fs-glob"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: util function helpers match Node under @types/node", async () => {
  const outDir = outDirFor("node-util-callables");
  const entry = join(nodeTypesDir, "util-callables.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "util-callables"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: Cipheriv and Decipheriv match Node under @types/node", async () => {
  const outDir = outDirFor("node-cipher");
  const entry = join(nodeTypesDir, "cipher.ts");
  const result = await compile(entry, { outPath: join(outDir, "cipher"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: ECDH matches Node under @types/node", async () => {
  const outDir = outDirFor("node-ecdh");
  const entry = join(nodeTypesDir, "ecdh.ts");
  const result = await compile(entry, { outPath: join(outDir, "ecdh"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: DiffieHellman matches Node under @types/node", async () => {
  const outDir = outDirFor("node-dh");
  const entry = join(nodeTypesDir, "dh.ts");
  const result = await compile(entry, { outPath: join(outDir, "dh"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: asymmetric keys and signatures match Node under @types/node", async () => {
  const outDir = outDirFor("node-keys");
  const entry = join(nodeTypesDir, "keys.ts");
  const result = await compile(entry, { outPath: join(outDir, "keys"), outDir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: X25519 keys and diffieHellman match Node under @types/node", async () => {
  const outDir = outDirFor("node-diffie-hellman");
  const entry = join(nodeTypesDir, "diffie-hellman.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "diffie-hellman"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: WebCrypto ECDSA, Ed25519 and RSA match Node under @types/node", async () => {
  const outDir = outDirFor("node-webcrypto-ecdsa");
  const entry = join(nodeTypesDir, "webcrypto-ecdsa.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "webcrypto-ecdsa"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: WebCrypto HMAC matches Node under @types/node", async () => {
  const outDir = outDirFor("node-webcrypto-hmac");
  const entry = join(nodeTypesDir, "webcrypto-hmac.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "webcrypto-hmac"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: WebCrypto secret keys match Node under @types/node", async () => {
  const outDir = outDirFor("node-webcrypto-keys");
  const entry = join(nodeTypesDir, "webcrypto-keys.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "webcrypto-keys"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: the navigator global's runtime probe matches Node under @types/node", async () => {
  const outDir = outDirFor("node-navigator");
  const entry = join(nodeTypesDir, "navigator.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "navigator"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: declared-but-not-lowered surface fences, naming @types/node", async () => {
  const outDir = outDirFor("node-fenced");
  const result = await compile(join(nodeTypesDir, "fenced.ts"), {
    outPath: join(outDir, "fenced"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const rendered = renderDiagnostics(result.diagnostics, result.sourceTexts, {
    color: false,
  }).replaceAll(nodeTypesDir + "/", "");
  await expect(rendered).toMatchFileSnapshot("__snapshots__/node-types-fenced.txt");
});

test("json-any: any-typed JSON.parse reads pass preflight (the project's own tsc is the oracle) and LOWER now; the non-Error reject still fences", async () => {
  const outDir = outDirFor("json-any");
  const entry = join(fixture("json-any"), "main.ts");
  // Analyzable: the program typechecks under its own tsconfig, so the
  // override-manufactured errors (parse(): unknown, reject's pinned
  // `(reason: Error) => void`) never fail preflight — coverage computes
  // instead of stopping.
  const { coverage } = analyze(entry);
  expect(coverage.preflightFailed).toBe(false);
  // The build still fails — at LOWERING, with the honest fence for the
  // string reject (a bound reject called with an Error is the supported
  // surface and lowers). The unknown READS lower now (the dyn keyed read,
  // corpus 1544) — no SC1100 remains. Never a SC0001.
  const result = await compile(entry, {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const codes = result.diagnostics.map((d) => d.code);
  expect(codes).not.toContain("SC0001");
  expect(codes).not.toContain("SC1100");
  expect(
    result.diagnostics.some((d) => d.message.includes("'string' values where 'Error' is expected")),
  ).toBe(true);
});

test("json-any-broken: genuine type errors report the project world's own tsc errors, not override-manufactured ones", async () => {
  const outDir = outDirFor("json-any-broken");
  const result = await compile(join(fixture("json-any-broken"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const tsc = result.diagnostics.filter((d) => d.code === "SC0001");
  expect(tsc.some((d) => d.message.includes("is not assignable to type 'number'"))).toBe(true);
  // The 'unknown' complaint exists only in the lowering world — the
  // reported set is the project world's, reproducible with their own tsc.
  expect(tsc.some((d) => d.message.includes("'unknown'"))).toBe(false);
});

test("null-floor: disabling strictNullChecks fails with the floor diagnostic", async () => {
  const outDir = outDirFor("floor");
  const result = await compile(join(fixture("null-floor"), "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toContain("SC0002");
  expect(result.diagnostics[0]!.message).toContain("strictNullChecks");
});

test("no-types-node: a bare project outside the repo compiles on the fallback declarations", async () => {
  // The npm-install shape: a fresh directory whose package.json has no
  // "type" and whose node_modules has no @types/node — the shipped
  // fallback d.ts is the whole Node surface. Regression: tsgo treats a
  // d.ts under a type:module package as ESM and bans its `export =`
  // ambient-module blocks (9× SC0001 at 1:1); ambient/package.json pins
  // the realm to commonjs so the fallback stays a legal global script.
  const dir = mkdtempSync(join(tmpdir(), "scriptc-bare-project-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bare", version: "1.0.0" }));
  writeFileSync(join(dir, "main.ts"), 'const who: string = "bare";\nconsole.log(`hi ${who}`);\n');
  const outDir = outDirFor("bare");
  const result = await compile(join(dir, "main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("hi bare\n");
});

test("dot-parent: bare '.' and '..' imports build and run (the TS project dialect)", async () => {
  // The vercel-CLI spelling (`from '..'` for a parent directory's index):
  // scriptc-only — Node refuses directory imports when running raw TS as
  // ESM, but the compiled program follows the project's own bundler-
  // resolution dialect (the SEMANTICS.md relative-specifier note).
  const outDir = outDirFor("dot-parent");
  const result = await compile(join(repoRoot, "tests/coverage-fixtures/dot-parent/main.ts"), {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("parent-banner:lib-index!\n");
});

test("node-types: terminal properties and filesystem error metadata match Node", async () => {
  const outDir = outDirFor("terminal-error-fields");
  const entry = join(nodeTypesDir, "terminal-error-fields.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "terminal-error-fields"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});

test("node-types: process.versions entries @types/node declares as strings read undefined when absent", async () => {
  const outDir = outDirFor("process-versions-absent");
  const entry = join(nodeTypesDir, "process-versions-absent.ts");
  const result = await compile(entry, {
    outPath: join(outDir, "process-versions-absent"),
    outDir,
    sanitize,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath),
    execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", entry]),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(comparableStderr(native.stderr)).toBe(node.stderr);
});
