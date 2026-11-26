import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The IR a program lowers to for the build target `target` selects. */
async function ir(source: string, target: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-process-credentials-"));
  const oldTarget = process.env["SCRIPTC_TARGET"];
  try {
    process.env["SCRIPTC_TARGET"] = target;
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = oldTarget;
    await rm(dir, { recursive: true, force: true });
  }
}

/** feature-detects a reader, as a program that falls back on a platform
 * without the member does. */
const FEATURE_DETECT = `
  const uid = process.getuid ? process.getuid() : 501;
  console.log("uid", uid);
  export {};
`;

test("a credential reader reads as a function on a POSIX target", async () => {
  expect(await ir(FEATURE_DETECT, "x86_64-unknown-linux-gnu")).toContain(
    "builtin.value.process.getuid",
  );
});

test("a credential reader reads as undefined where the process model has none", async () => {
  // Windows and WASI expose no uid/gid members: a truthiness test must take
  // the fallback instead of calling a reader that throws.
  expect(await ir(FEATURE_DETECT, "x86_64-windows-gnu")).not.toContain(
    "builtin.value.process.getuid",
  );
  expect(await ir(FEATURE_DETECT, "wasm32-wasi")).not.toContain("builtin.value.process.getuid");
});
