import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

// A Provider<"beta"> held as Provider<Api> receives an alpha model through
// method bivariance: Model<"beta">'s compat holds only undefined, so the
// alpha model's compat object cannot convert. Native throws the checked
// conversion's TypeError (types don't lie); Node prints `beta cancel a1 lie`
// and `passed through` instead, because its method call never checks the
// argument's shape. That divergence is the documented checked-conversion
// policy, so this case is a native package test rather than a differential
// corpus program.
const program = `// A Provider<"beta"> held as Provider<Api> receives an alpha model through
// method bivariance: Model<"beta">'s compat holds only undefined, so the
// alpha model's compat object cannot convert. Native throws the checked
// conversion's TypeError (types don't lie); Node passes the lie through.
type Api = "alpha" | "beta";
interface AlphaCompat { strict?: boolean }
interface Model<TApi extends Api> {
  id: string;
  api: TApi;
  compat?: TApi extends "alpha" ? AlphaCompat : never;
}
interface Provider<TApi extends Api = Api> {
  readonly id: string;
  cancel?(model: Model<TApi>, handle: string): Promise<void>;
}
function betaProvider(): Provider<"beta"> {
  return {
    id: "b",
    cancel: async (model, handle) => {
      console.log("beta cancel", model.id, handle);
    },
  };
}
async function main(): Promise<void> {
  const providers: Provider[] = [betaProvider()];
  const beta = providers[0]!;
  await beta.cancel?.({ id: "b1", api: "beta" }, "ok");
  try {
    await beta.cancel?.({ id: "a1", api: "alpha", compat: { strict: true } }, "lie");
    console.log("passed through");
  } catch (error) {
    console.log(error instanceof TypeError, (error as Error).message);
  }
}
main();
`;

// A provider of two kinds held as a provider of every kind receives a model
// whose compat was built as the third kind's record. The records have only
// optional members, so the value's properties say which of the method's two
// arms it is: one that has `strict` is the first, one that has `limit` the
// second, and both agree with Node (the corpus program
// method-param-union-arm-by-properties.ts pins those). A value that has both
// is neither arm alone: the method could read `strict` through one arm and
// `limit` through the other, and no single arm answers both. Native throws the
// checked conversion's TypeError at the call; Node prints `two strict limit`.
const split = `type Api = "alpha" | "beta" | "gamma";
interface AlphaCompat { strict?: boolean; first?: string }
interface BetaCompat { limit?: number; second?: string }
interface GammaCompat { strict?: boolean; limit?: number }
interface CompatMap { alpha: AlphaCompat; beta: BetaCompat; gamma: GammaCompat }
interface Model<TApi extends Api> {
  id: string;
  api: TApi;
  compat?: CompatMap[TApi];
}
interface Provider<TApi extends Api = Api> {
  readonly id: string;
  describe(model: Model<TApi>): string;
}
function twoProvider(): Provider<"alpha" | "beta"> {
  return {
    id: "two",
    describe: (model) => {
      const compat = model.compat;
      const parts: string[] = [model.id];
      if (compat !== undefined && "strict" in compat) parts.push("strict");
      if (compat !== undefined && "limit" in compat) parts.push("limit");
      return parts.join(" ");
    },
  };
}
function gamma(id: string, compat: GammaCompat): Model<Api> {
  return { id, api: "gamma", compat };
}
const providers: Provider[] = [twoProvider()];
const two = providers[0]!;
console.log(two.describe(gamma("one", { strict: true })));
console.log(two.describe(gamma("other", { limit: 2 })));
console.log(two.describe(gamma("none", {})));
try {
  console.log(two.describe(gamma("two", { strict: true, limit: 2 })));
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
`;

async function runNative(source: string): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-method-field-adapters-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const result = await compile(entry, {
      backend: "llvm",
      sanitize,
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return undefined;
    const child = spawnSync(result.binaryPath, { encoding: "utf8" });
    const stderr =
      sanitize && process.platform === "linux"
        ? child.stderr.replace(
            /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm,
            "",
          )
        : child.stderr;
    expect(stderr).toBe("");
    expect(child.status).toBe(0);
    return child.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checked method-field adapters throw on an instantiation mismatch (llvm)", async () => {
  expect(await runNative(program)).toBe(
    "beta cancel b1 ok\ntrue a '{ strict: boolean | undefined }' value is not representable in the target union (a value narrowed or asserted past it still held it)\n",
  );
});

test("a value with properties of two arms has no arm in a checked method-field adapter (llvm)", async () => {
  expect(await runNative(split)).toBe(
    "one strict\nother limit\nnone\ntrue a '{ limit: number | undefined; strict: boolean | undefined }' value is not representable in the target union (no arm of it declares every property the value has)\n",
  );
});
