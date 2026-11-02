/* The npm suite (npm.test.ts runs it as built by default,
 * npm-shape-overlay.test.ts with shape inference's overlay on).
 *
 * npm packages compiled natively: every program under tests/fixtures/npm/cases
 * (plus the commander fixtures in npm-cases.ts) builds with the default
 * static npm compile and runs against Node. A case matches Node (stdout and
 * exit status for every argv list, stderr when it opts in with
 * `// @stderr`) unless KNOWN records how it differs:
 *
 * - build: the compile refuses it with this diagnostic code;
 * - run: it compiles, and the program's output names this diagnostic code
 *   (a refusal deferred to the operation that reached it), for every argv
 *   list or for the listed `argvs`, while the other lists match Node;
 * - divergence: it runs but does not match Node yet. These run as expected
 *   failures, so a fix that makes one match fails here until KNOWN drops it;
 * - island: a package it imports runs in a Node island (scope-B NI-4): with
 *   a libnode pack (SCRIPTC_LIBNODE) it matches Node; without one the build
 *   stops with SC8005 (no pack to load Node from).
 *
 * The fixture node_modules are committed test data. Binaries compile the
 * package sources at build time and read nothing from node_modules at run
 * time.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { npmCases, type NpmCase } from "./npm-cases.js";
import { shardSelect, shardSuffix } from "./shard.js";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

type Known =
  | { build: string }
  | { run: string; argvs?: string[][] }
  | { divergence: string }
  | { island: true };

const KNOWN: Record<string, Known> = {
  "assert-shims": { run: "SC1043" },
  "buffer-shims": { run: "SC2020" },
  "bytes-exit": { island: true },
  "cjs-esm-named": { island: true },
  "cjs-lexer-aligned": { island: true },
  "commander-calc": { run: "SC1090", argvs: [["--help"]] },
  "commander-calc-async": { run: "SC1090", argvs: [["--help"]] },
  "create-require": { run: "SC1090" },
  "dotfolder": { island: true },
  "dual-package-kinds": { island: true },
  "dynamic-import": { island: true },
  "dynamic-import-local": { build: "SC2012" },
  "esbuild-require": { island: true },
  "esm-missing-default": { build: "SC1090" },
  "esm-missing-export": { build: "SC1090" },
  "fs-shims": { run: "SC1101" },
  "import-refusal": { build: "SC2020" },
  "island-registry": { build: "SC2011" },
  "island-timers": {
    divergence:
      "Timeout handles are numbers (typeof) and lose their ref flag once fired or cleared",
  },
  // require() inside a function.
  "island-web-plumbing": { run: "SC1090" },
  // The package's require() edges run in a Node island and match Node; its
  // import() of a specifier that resolves to nothing is a deferred SC2012
  // fence instead of Node's ERR_MODULE_NOT_FOUND rejection.
  "lazy-traps": {
    divergence:
      "an import() whose literal specifier resolves to nothing is fenced with SC2012 instead of rejecting like Node",
  },
  "misc-shims": { run: "SC1090" },
  namespace: { island: true },
  "node24-async-events": { run: "SC2020" },
  "node24-commonjs-metadata": { island: true },
  "node24-crypto-kdf": { run: "SC2020" },
  "node24-deep-equality": { run: "SC2020" },
  "node24-diagnostics-async": { run: "SC1090" },
  "node24-diagnostics-tracing": { run: "SC1090" },
  "node24-env": { run: "SC1090" },
  "node24-esm-metadata": { island: true },
  "node24-event-emitter": { run: "SC2020" },
  "node24-file-url-conversion": { island: true },
  "node24-fs-descriptors": { run: "SC2020" },
  "node24-mime": { run: "SC2020" },
  "node24-mime-errors": { run: "SC2020" },
  "node24-no-error-assertions": { run: "SC2020" },
  // The dynamic `__proto__` writes in the args loop now match Node, so the
  // program reaches a later limitation: the checked conversion of the options
  // array's element union, whose `{ __proto__: null, ... }` arm (B.3.1) leaves
  // a value without the `__proto__` member its literal type declares.
  "node24-parseargs": {
    divergence:
      "the checked conversion into the options-literal union fails its `__proto__: null` arm",
  },
  "node24-promise-timers": { run: "SC2020" },
  // The decoding, encoding and input-error lines match Node; the closing
  // `d.encoding = 'hex'` assignment refuses.
  "node24-string-decoder": { run: "SC1090" },
  "node24-style-text": { run: "SC2020" },
  "node24-system-errors": { run: "SC1090" },
  "node24-text-encoding": { run: "SC2020" },
  // The fixture builds a String and a Number wrapper, which used to refuse
  // with SC2020 and now compile: the case runs, but Node's
  // ERR_INVALID_ARG_TYPE names a wrapper's class (`an instance of String`)
  // where the error formatter prints `Object`, and the program's own
  // `String(functionValue)` prints `function () { [native code] }` for a
  // named function where Node prints its source.
  "node24-text-utilities": {
    divergence:
      "wrapper objects reach the text utilities now, but ERR_INVALID_ARG_TYPE names them `Object` instead of `String`/`Number`, and function values print without their source",
  },
  "node24-timers-unref": { run: "SC2020" },
  "node24-url-factories": { run: "SC2020" },
  "node24-url-mutation": { run: "SC1090" },
  "node24-util-adapters": { run: "Object.create with this value is not supported yet" },
  "node24-util-types": { run: "SC1090" },
  "package-imports": { island: true },
  "promise-bridge": { build: "SC1090" },
  "self-name": { build: "SC2013" },
  "util-shims": { run: "SC2020" },
  // The package redeclares the var it exported: Node copies the first value.
  "var-export-redeclared": { island: true },
  // `class Upper extends TransformStream`: extending a builtin class from JavaScript.
  "web-streams": { run: "SC1090" },
  "workspace-copied": { island: true },
  "workspace-unclean": { build: "SC2013" },
};

/** Where the overlay changes how a case KNOWN refuses (none today). */
const OVERLAY_KNOWN: Record<string, Known> = {};

/** Per-case timeouts past the default 120 s: the undici cases compile the
 * built-in undici implementation's module graph, the zod 3 cases (zod3,
 * zod3-adoption, zod3-boundary, zod3-infer) compile zod 3's 3,700-line
 * types module, and the zod 4 cases (zod4-boundary, zod4-record,
 * hono-zod-validator, hono-zod-default-hook)
 * compile zod 4's core, classic API and locales. A sanitized build of any
 * of them takes minutes on a CI runner. commander-calc-async runs four
 * command lines, and with the shape overlay its build analyzes commander
 * for most of a minute. */
const TIMEOUTS: Record<string, number> = {
  "commander-calc-async": 300_000,
  "hono-zod-default-hook": 900_000,
  "hono-zod-validator": 900_000,
  undici5: 600_000,
  undici7: 600_000,
  "zod4-boundary": 900_000,
  "zod4-record": 900_000,
  zod3: 600_000,
  "zod3-adoption": 600_000,
  "zod3-boundary": 600_000,
  "zod3-infer": 600_000,
};

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function programStderr(stderr: Buffer): Buffer {
  if (!sanitize) return stderr;
  // Linux ASan emits this instrumentation warning at the first fiber swap.
  // Latin-1 preserves every other byte, including non-UTF-8 program output.
  return Buffer.from(
    stderr
      .toString("latin1")
      .replace(
        /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
        "",
      ),
    "latin1",
  );
}

async function runBinary(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  try {
    // stdin closes immediately, as in differential.test.ts: a program that
    // reads fd 0 to EOF must not hang on an open pipe.
    const pending = execFileAsync(cmd, args, { cwd, encoding: "buffer" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; signal?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (!Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) throw err;
    const exitCode = typeof e.code === "number" ? e.code : -1;
    if (exitCode === -1 && typeof e.signal !== "string") throw err;
    return { stdout: e.stdout, stderr: e.stderr, exitCode };
  }
}

type Built = { ok: true; binary: string } | { ok: false; codes: string[]; text: string };

/** Compile once per (entry, lane); the cache key hashes the program and the
 * fixture packages so edits to either rebuild. */
async function build(entry: string, shapeOverlay: boolean | undefined): Promise<Built> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(dirname(entry), "*.{ts,mts,cts,js,mjs,cjs,json}")),
    ...globSync(join(fixturesRoot, "npm/node_modules/**/*.{js,mjs,cjs,json,d.ts,node}")),
  ].sort();
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update(shapeOverlay === undefined ? "" : `overlay=${shapeOverlay}`)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `npm-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    ...(shapeOverlay === undefined ? {} : { shapeOverlay }),
  });
  if (result.ok) return { ok: true, binary: result.binaryPath };
  return {
    ok: false,
    codes: result.diagnostics.map((d) => d.code),
    text: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
  };
}

/** Node's uncaught-error report ends with `Node.js v<version>`: the island
 * prints libnode's release, which may differ from the reference Node's
 * patch release. */
function normalizeNodeVersion([a, b]: [string, string]): [string, string] {
  const re = /^Node\.js v\d+\.\d+\.\d+$/m;
  return [a.replace(re, "Node.js v<version>"), b.replace(re, "Node.js v<version>")];
}

/** The two stderr texts with their stack frame runs cut to the frames
 * they share: an uncaught error from a Node island prints Node's report,
 * whose frames match Node's from the throw site up to the first native
 * frame, which has no Node-identical spelling (DESIGN.md §2.10). Every
 * other line, and each run's common leading frames, compare exactly. */
function sharedFrames(native: Buffer, node: Buffer): [string, string] {
  const frame = (line: string): boolean => /^ {4}at /.test(line);
  const a = native.toString("utf8").split("\n");
  const b = node.toString("utf8").split("\n");
  const outA: string[] = [];
  const outB: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && frame(a[i]!) && frame(b[j]!)) {
      while (i < a.length && j < b.length && frame(a[i]!) && a[i] === b[j]) {
        outA.push(a[i++]!);
        outB.push(b[j++]!);
      }
      while (i < a.length && frame(a[i]!)) i++;
      while (j < b.length && frame(b[j]!)) j++;
      continue;
    }
    if (i < a.length) outA.push(a[i++]!);
    if (j < b.length) outB.push(b[j++]!);
  }
  return [outA.join("\n"), outB.join("\n")];
}

/** A Node island's modules run from the module tree the program ships
 * (node-islands/modules.ts), extracted under the user's cache directory, so
 * a path they print names the tree's copy. The tree's root is the fixtures'
 * npm directory: such a path reads as the fixture's own. */
function fixturePaths(out: Buffer): Buffer {
  const tree = /(?:\/[^\s"'`/]+)+\/scriptc\/node-islands\/[0-9a-f]{64}/g;
  return Buffer.from(out.toString("utf8").replace(tree, join(fixturesRoot, "npm")), "utf8");
}

async function expectMatchesNode(c: NpmCase, binary: string, islandFrames = false): Promise<void> {
  const cwd = dirname(c.entry);
  for (const argv of c.argvs ?? [[]]) {
    const [nodeRes, ran] = await Promise.all([
      runBinary(process.execPath, [c.entry, ...argv], cwd),
      runBinary(binary, argv, cwd),
    ]);
    const nativeRes = islandFrames
      ? { ...ran, stdout: fixturePaths(ran.stdout), stderr: fixturePaths(ran.stderr) }
      : ran;
    const label = argv.join(" ");
    if (!nodeRes.stdout.equals(nativeRes.stdout)) {
      expect(nativeRes.stdout.toString("utf8"), label).toBe(nodeRes.stdout.toString("utf8"));
      expect.unreachable("stdout differed at byte level but not after utf8 decode");
    }
    expect(nativeRes.exitCode, label).toBe(nodeRes.exitCode);
    if (c.compareStderr && islandFrames) {
      const [native, node] = normalizeNodeVersion(
        sharedFrames(programStderr(nativeRes.stderr), nodeRes.stderr),
      );
      expect(native, label).toBe(node);
    } else if (c.compareStderr)
      expect(programStderr(nativeRes.stderr), label).toEqual(nodeRes.stderr);
  }
}

/** Defines the suite. `shapeOverlay` is passed to every compile (unset: the
 * default build). With the overlay on, every case must still build and run
 * as KNOWN records for the default build, except that a refused build may
 * compile, and then matches Node. */
export function defineNpmSuite(options: { label: string; shapeOverlay?: boolean }): void {
  const { label, shapeOverlay } = options;
  const cases = shardSelect(npmCases(fixturesRoot), (c) => c.name);
  test("every KNOWN entry names a case", () => {
    const names = new Set(npmCases(fixturesRoot).map((c) => c.name));
    expect(Object.keys(KNOWN).filter((name) => !names.has(name))).toEqual([]);
  });

  describe(`${label} (${cases.length} programs${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
    // With many shards some own no program; an empty suite would fail the file.
    if (cases.length === 0) test.skip("no npm program falls in this shard", () => {});
    for (const c of cases) {
      const known = (shapeOverlay === true ? OVERLAY_KNOWN[c.name] : undefined) ?? KNOWN[c.name];
      if (known !== undefined && "divergence" in known) {
        test.fails(`${c.name} (diverges: ${known.divergence})`, async () => {
          const built = await build(c.entry, shapeOverlay);
          if (!built.ok) throw new Error(built.text);
          await expectMatchesNode(c, built.binary);
        }, 120_000);
        continue;
      }
      if (known !== undefined && "island" in known) {
        test(`${c.name} (Node island)`, async () => {
          const built = await build(c.entry, shapeOverlay);
          if (libnodePack() === null) {
            expect(built.ok, "no libnode pack: the compile stops").toBe(false);
            if (!built.ok) expect(built.codes, built.text).toContain("SC8005");
            return;
          }
          if (!built.ok) throw new Error(`npm fixture failed to compile:\n${built.text}`);
          await expectMatchesNode(c, built.binary, true);
        }, 120_000);
        continue;
      }
      test(
        c.name,
        async () => {
          const built = await build(c.entry, shapeOverlay);
          if (known !== undefined && "build" in known) {
            // The overlay may type code the default build refuses: such a
            // program must then match Node.
            if (shapeOverlay === true && built.ok) {
              await expectMatchesNode(c, built.binary);
              return;
            }
            expect(built.ok, "the compile refuses the program").toBe(false);
            if (!built.ok) expect(built.codes, built.text).toContain(known.build);
            return;
          }
          if (!built.ok) throw new Error(`npm fixture failed to compile:\n${built.text}`);
          if (known !== undefined && "run" in known) {
            for (const argv of known.argvs ?? c.argvs ?? [[]]) {
              const res = await runBinary(built.binary, argv, dirname(c.entry));
              const output = res.stdout.toString("utf8") + res.stderr.toString("utf8");
              expect(output, `${argv.join(" ")}: the deferred refusal`).toContain(known.run);
            }
            if (known.argvs === undefined) return;
            const refused = new Set(known.argvs.map((argv) => JSON.stringify(argv)));
            const argvs = (c.argvs ?? [[]]).filter((argv) => !refused.has(JSON.stringify(argv)));
            await expectMatchesNode({ ...c, argvs }, built.binary);
            return;
          }
          await expectMatchesNode(c, built.binary);
        },
        TIMEOUTS[c.name] ?? 120_000,
      );
    }
  });
}
