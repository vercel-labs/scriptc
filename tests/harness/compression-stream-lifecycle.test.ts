/* Short-lived compression streams leave nothing behind: a stream that is
 * closed, one that errors, one that is cancelled and one that is discarded
 * after its engine has run are dropped round after round, and the process's
 * peak RSS stays at the runtime's own footprint. A stranded state reference
 * keeps every dropped engine alive (about 260 KiB each) and shows up here as
 * growth. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const LIFECYCLE = `import { gzipSync } from "node:zlib";
const payload = new TextEncoder().encode("payload".repeat(64));
const compressed = new Uint8Array(gzipSync(Buffer.from(payload)));
const big = new Uint8Array(256 * 1024).fill(7);
const rounds = 600;
for (let i = 0; i < rounds; i++) {
  const closed = new CompressionStream("gzip");
  const closedWriter = closed.writable.getWriter();
  await closedWriter.write(payload);
  await closedWriter.close();

  const decompressed = new DecompressionStream("gzip");
  const decompressedWriter = decompressed.writable.getWriter();
  const decompressedReader = decompressed.readable.getReader();
  const reading = (async () => {
    let total = 0;
    for (;;) {
      const { value, done } = await decompressedReader.read();
      if (done) break;
      total += value.length;
    }
    return total;
  })();
  await decompressedWriter.write(compressed);
  await decompressedWriter.close();
  if ((await reading) !== payload.length) console.log("bad round", i);

  const errored = new DecompressionStream("gzip");
  const erroredWriter = errored.writable.getWriter();
  void erroredWriter.write(new Uint8Array([1, 2, 3, 4])).catch(() => {});

  const cancelled = new DecompressionStream("gzip");
  const cancelledReader = cancelled.readable.getReader();
  await cancelledReader.cancel("done");

  // Discarded after its engine ran: a pending read pulls for one chunk, the
  // write feeds the engine, and then both streams are dropped unclosed.
  const abandonedCompressor = new CompressionStream("gzip");
  const abandonedReader = abandonedCompressor.readable.getReader();
  void abandonedReader.read();
  await abandonedCompressor.writable.getWriter().write(big);

  const abandonedDecompressor = new DecompressionStream("gzip");
  const abandonedBytes = abandonedDecompressor.readable.getReader();
  void abandonedBytes.read();
  await abandonedDecompressor.writable.getWriter().write(compressed);

  if (i % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log("lifecycle", rounds, "maxrss", Math.round(process.resourceUsage().maxRSS));
`;

async function run(source: string): Promise<{ stdout: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-compression-lifecycle-"));
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

test("short-lived compression streams do not strand their engines", async () => {
  const { stdout, code } = await run(LIFECYCLE);
  expect(code).toBe(0);
  const match = /lifecycle (\d+) maxrss (\d+)/.exec(stdout);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(600);
  /* A stranded engine per round would add roughly 300 MiB by round 600 over
   * the runtime's own footprint. The sanitized lane's AddressSanitizer and
   * RC audit check the leak directly and inflate memory, so the RSS bound
   * applies to the plain lane. */
  if (process.env["SCRIPTC_SAN"] !== "1") expect(Number(match![2])).toBeLessThan(180 * 1024);
}, 600_000);
