import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { analyze, compile, deserializeModule, serializeModule } from "@scriptc/compiler";
import { IR_VERSION } from "../../packages/compiler/src/ir/serialize.js";
import {
  F64,
  STRING,
  VOID,
  arrayOf,
  type IrExpr,
  type IrLibFn,
  type IrModule,
  type IrType,
} from "../../packages/compiler/src/ir/ir.js";
import { strLit } from "../../packages/compiler/src/ir/build.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = join(root, "tests/fixtures/self-hosting/runtime-features.ts");
const loc = { file: "runtime-features.ts", start: 0, end: 1 };
const empty = (): IrModule => ({
  irVersion: IR_VERSION,
  sourceFile: loc.file,
  entry: "main",
  functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
});
const lib = (fn: IrLibFn): IrExpr => ({ kind: "libCall", fn, args: [], type: VOID, loc });

// Dependency detection deliberately examines structure without executing
// calls or validating their signatures. These trees isolate a link feature
// even when running that API would require sockets, files, or a test loop.
const featureCalls: readonly [string, IrLibFn][] = [
  ["legacyTextDecoder", "text.decodeLegacy"],
  ["fetch", "fetch.start"],
  ["processEvents", "process.onExit"],
  ["emitter", "emitter.getMax"],
  ["stream", "readable.read"],
  ["zlib", "zlib.gzipSync"],
  ["dc", "dc.channel"],
  ["assert", "assert.ok"],
  ["dynInvoke", "dyn.defineProps"],
  ["dynAsync", "async.awaitDyn"],
  ["inspect", "insp.f64"],
  ["childProcess", "cp.spawnSync"],
  ["net", "net.createServer"],
  ["symbol", "sym.for"],
  ["bigint", "bigint.parse"],
  ["searchParams", "sp.new"],
  ["qs", "qs.parse"],
  ["utilPromisify", "util.promisifyDyn"],
  ["dynBuiltinClass", "dyn.builtinClass"],
  ["dynBuiltinStream", "dyn.builtinStreamClass"],
  ["parseArgs", "util.parseArgs"],
  ["parseArgs", "util.isDeepStrictEqual"],
  ["parseArgs", "util.styleText"],
  ["fsWatch", "fs.watch"],
  ["nodeTest", "test.register"],
  ["dgram", "dgram.createSocket"],
  ["http", "http.createServer"],
  ["http2", "http2.connect"],
  ["tls", "tls.connect"],
  ["tlsCa", "tlsca.get"],
];

test("the production runtime dependency scanners lower entirely statically", () => {
  const { coverage } = analyze(entry, {});
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.stats.statementsTotal).toBeGreaterThan(150);
  expect(coverage.stats.statementsFailed).toBe(0);
  expect(coverage.stats.functionsSkipped).toBe(0);
});

for (const backend of ["llvm"] as const) {
  test(`self-hosting runtime dependency detection (${backend})`, async () => {
    const dir = mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-features-"),
    );
    try {
      const built = await compile(entry, {
        outDir: dir,
        outPath: join(dir, process.platform === "win32" ? "features.exe" : "features"),
        backend,
        optimization: "dev",
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(built.backend).toBe(backend);
      const check = (
        name: string,
        module: IrModule,
        positive: string[] = [],
        negative: string[] = [],
      ): void => {
        const input = join(dir, "input.json");
        writeFileSync(input, serializeModule(module));
        const options = { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 };
        const oracle = spawnSync(process.execPath, ["--import", "tsx", entry, input], options);
        const native = spawnSync(built.binaryPath, [input], options);
        for (const result of [oracle, native]) {
          expect(result.error, name).toBeUndefined();
          expect(result.signal, name).toBeNull();
          expect(result.status, `${name}: ${result.stderr}`).toBe(0);
        }
        expect(native.stdout, name).toEqual(oracle.stdout);
        expect(native.stderr, name).toEqual(oracle.stderr);
        const features = JSON.parse(native.stdout.toString()) as Record<string, boolean>;
        for (const feature of positive) expect(features[feature], `${name}: ${feature}`).toBe(true);
        for (const feature of negative)
          expect(features[feature], `${name}: ${feature}`).toBe(false);
      };
      const none = featureCalls
        .map(([feature]) => feature)
        .concat(["regex", "copying", "fileHandle"]);
      check("empty module", empty(), [], none);
      for (const [feature, fn] of featureCalls) {
        const module = empty();
        // Put the use inside an uncalled function and multiple nested
        // bodies. Link requirements must not depend on entry execution.
        module.functions.push({
          name: "callback",
          params: [],
          locals: [],
          returnType: VOID,
          loc,
          body: [{ kind: "block", body: [{ kind: "exprStmt", expr: lib(fn), loc }], loc }],
        });
        check(
          fn,
          module,
          fn === "util.isDeepStrictEqual"
            ? [feature, "symbol"]
            : fn === "util.styleText"
              ? [feature, "inspect", "processEvents", "dynAsync"]
              : [feature],
        );
      }
      const regex = empty();
      regex.functions[0]!.body.push({
        kind: "exprStmt",
        expr: {
          kind: "strIntrinsic",
          method: "toLowerCase",
          receiver: strLit("UPPER", loc),
          args: [],
          type: STRING,
          loc,
        },
        loc,
      });
      check("case conversion links regex Unicode tables", regex, ["regex"]);
      const copying = empty();
      copying.functions[0]!.body.push({
        kind: "exprStmt",
        expr: {
          kind: "arrIntrinsic",
          method: "toReversed",
          receiver: { kind: "arrayLit", elems: [], type: arrayOf(F64), loc },
          args: [],
          type: arrayOf(F64),
          loc,
        },
        loc,
      });
      check("copying intrinsic", copying, ["copying"]);
      const handle = empty();
      const handleType: IrType = { kind: "promise", inner: { kind: "fileHandle" } };
      handle.functions[0]!.locals.push({
        id: "handle.0",
        name: "handle",
        mutable: false,
        type: handleType,
      });
      check("nested result type", handle, ["fileHandle"]);

      const strings = empty();
      strings.functions[0]!.body.push({
        kind: "exprStmt",
        expr: strLit("fetch.start regexLit tls.connect bigint.parse", loc),
        loc,
      });
      check("ordinary string data is not IR", strings, [], none);
      // Audit genuine frontend output too, including closure tables,
      // recursive types, metadata and JSON callback helper functions.
      for (const [source, feature] of [
        ["tests/corpus/3097-json-callback-reentrancy.ts", ""],
        ["tests/corpus/1002-json-parse-cast.ts", ""],
        ["tests/corpus/2975-bigint-default-radix.ts", "bigint"],
        ["tests/corpus/2678-util-parseargs.ts", "parseArgs"],
        ["tests/corpus/2557-tls-ca-store.ts", "tlsCa"],
      ]) {
        const path = join(dir, "emitted.json");
        const emitted = await compile(join(root, source!), {
          outDir: dir,
          outPath: path,
          outputKind: "ir",
        });
        if (!emitted.ok)
          throw new Error(emitted.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        check(source!, deserializeModule(readFileSync(path, "utf8")), feature ? [feature] : []);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
