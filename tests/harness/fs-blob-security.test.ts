/* File-backed Blob security contracts Node cannot oracle.
 *
 * - Node's blob reader accepts a same-length rewrite when the mtime is
 *   restored exactly (verified), so the change-time guard is pinned here.
 * - Node's openAsBlob reports a zero size for files at or above 4 GiB, so a
 *   nested chain past the byte allocator's limit cannot be built there; the
 *   rejection (instead of a native crash) is pinned here.
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit like every harness lane.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

async function compileAndRun(name: string, source: string): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `fs-blob-security-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  return stdout;
}

test("a same-length rewrite with a restored mtime rejects the read", async () => {
  const stdout = await compileAndRun(
    "restored-mtime",
    `import { openAsBlob } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
if (process.platform !== "linux") {
  console.log("skip non-linux");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-mtime-"));
  const file = path.join(dir, "f.bin");
  const reference = path.join(dir, "ref.bin");
  fs.writeFileSync(file, "aaaa");
  spawnSync("cp", ["-p", file, reference]);
  const blob = await openAsBlob(file);
  fs.writeFileSync(file, "bbbb");
  spawnSync("touch", ["-r", reference, file]); // restores the exact mtime
  console.log("size", fs.statSync(file).size);
  try {
    console.log("text", JSON.stringify(await blob.text()));
  } catch (error: any) {
    console.log("rejected", error.name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
`,
  );
  expect(stdout).toBe(
    process.platform === "linux" ? "size 4\nrejected NotReadableError\n" : "skip non-linux\n",
  );
});

test("a nested composition past the byte limit rejects instead of crashing", async () => {
  const stdout = await compileAndRun(
    "oversized-chain",
    `import { openAsBlob } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
if (process.platform !== "linux") {
  console.log("skip non-linux");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-large-"));
  const file = path.join(dir, "big.bin");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, 2 ** 40); // sparse
  let blob = await openAsBlob(file);
  console.log("base", blob.size);
  for (let i = 0; i < 14; i++) blob = new Blob([blob, blob]);
  console.log("size", blob.size);
  try {
    await blob.arrayBuffer();
    console.log("read ok");
  } catch (error: any) {
    console.log("rejected", error.name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
`,
  );
  expect(stdout).toBe(
    process.platform === "linux"
      ? "base 1099511627776\nsize 18014398509481984\nrejected RangeError\n"
      : "skip non-linux\n",
  );
});
