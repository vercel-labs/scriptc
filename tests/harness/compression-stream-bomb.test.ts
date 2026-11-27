/* A decompression bomb read slowly stays within a bounded peak RSS: the
 * streams produce output as the reader pulls and pause while the readable
 * queue is full, so one compressed chunk that expands to 64 MiB never
 * becomes a 64 MiB queue of expanded chunks. A differential corpus program
 * cannot state this: the number is the process's own peak RSS. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const BOMB = `const MB = 1024 * 1024;
const total = 256 * MB;
const compressor = new CompressionStream("gzip");
const cwriter = compressor.writable.getWriter();
const breader = compressor.readable.getReader();
const parts: Uint8Array[] = [];
const collecting = (async () => {
  for (;;) {
    const { value, done } = await breader.read();
    if (done) break;
    parts.push(value as Uint8Array);
  }
})();
const block = new Uint8Array(MB);
for (let i = 0; i < total / MB; i++) await cwriter.write(block);
await cwriter.close();
await collecting;
let length = 0;
for (const part of parts) length += part.length;
const joined = new Uint8Array(length);
let at = 0;
for (const part of parts) {
  joined.set(part, at);
  at += part.length;
}
const decompressor = new DecompressionStream("gzip");
const dwriter = decompressor.writable.getWriter();
const dreader = decompressor.readable.getReader();
let expanded = 0;
let reads = 0;
const reading = (async () => {
  for (;;) {
    const { value, done } = await dreader.read();
    if (done) break;
    expanded += value.length;
    if (++reads % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
})();
await dwriter.write(joined);
await dwriter.close();
await reading;
console.log("expanded", expanded, "maxrss", Math.round(process.resourceUsage().maxRSS));
`;

async function run(source: string): Promise<{ stdout: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-compression-bomb-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", code: -1 };
  try {
    const { stdout } = await execFileAsync(result.binaryPath, [], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; code?: number };
    return { stdout: failed.stdout ?? "", code: failed.code ?? -1 };
  }
}

test("a decompression bomb read slowly keeps a bounded peak RSS", async () => {
  const { stdout, code } = await run(BOMB);
  expect(code).toBe(0);
  const match = /expanded (\d+) maxrss (\d+)/.exec(stdout);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(256 * 1024 * 1024);
  /* The output is 256 MiB over a runtime whose own footprint is about 100
   * MiB: an unbounded queue of expanded chunks would put the peak near 350
   * MiB. The sanitized lane's ASan shadow inflates RSS by construction, so
   * the bound applies to the plain lane only. */
  if (process.env["SCRIPTC_SAN"] !== "1") expect(Number(match![2])).toBeLessThan(200 * 1024);
}, 300_000);
