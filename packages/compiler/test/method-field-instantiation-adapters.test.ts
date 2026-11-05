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

test.each(["llvm"] as const)(
  "checked method-field adapters throw on an instantiation mismatch (%s)",
  async (backend) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-method-field-adapters-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, program);
      const result = await compile(entry, {
        backend,
        sanitize,
        outDir: dir,
        outPath: join(dir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
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
      expect(child.stdout).toBe(
        "beta cancel b1 ok\ntrue a '{ strict: boolean | undefined }' value is not representable in the target union (a value narrowed or asserted past it still held it)\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
