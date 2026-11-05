#!/usr/bin/env node
/* Checks that unit records stand for the units they record.
 *
 * Each corpus program is compiled to LLVM text twice: as usual, and with
 * SCRIPTC_LOWER_JOURNAL=serial, where every reachable-emit unit that has a
 * record keeps the function and table entries its record carries
 * (frontend/lowering/unit-journal.ts). The two texts must be the same.
 *
 *   node scripts/recorded-lowering.mjs [--stride 1] [--offset 0] [--limit N]
 *     [--jobs 8] [--entry <file.ts>]... [--out <dir>]
 *
 * --stride and --offset sample the corpus entries in name order. Needs a
 * built compiler (pnpm build). Writes <out>/results.json, prints the programs
 * whose texts differ and the units each mode recorded, and exits with status
 * 1 when a program's texts differ or only one mode builds it. */
import { spawn } from "node:child_process";
import { globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "packages/compiler/dist");

if (process.argv[2] === "--child") {
  const [, , , entry, outPath] = process.argv;
  const { compile } = await import(pathToFileURL(join(dist, "index.js")).href);
  const outDir = join(tmpdir(), `scriptc-recorded-lowering-${process.pid}`);
  try {
    const result = await compile(entry, { outDir, outPath, outputKind: "llvm" });
    if (!result.ok)
      process.stderr.write(
        `${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}\n`,
      );
    process.exitCode = result.ok ? 0 : 3;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
} else {
  await main();
}

async function main() {
  const { values } = parseArgs({
    options: {
      stride: { type: "string", default: "1" },
      offset: { type: "string", default: "0" },
      limit: { type: "string", default: "100000" },
      jobs: { type: "string", default: String(Math.max(1, Math.floor(cpus().length / 2))) },
      entry: { type: "string", multiple: true, default: [] },
      out: { type: "string", default: join(tmpdir(), "scriptc-recorded-lowering") },
    },
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const corpus = join(root, "tests/corpus");
  const sampled =
    values.entry.length > 0
      ? values.entry.map((entry) => resolve(entry))
      : ["ts", "js", "mjs", "cjs"]
          .flatMap((ext) => [
            ...globSync(join(corpus, `*.${ext}`)),
            ...globSync(join(corpus, `*/main.${ext}`)),
          ])
          .sort()
          .filter((_, index) => index % Number(values.stride) === Number(values.offset))
          .slice(0, Number(values.limit));

  const child = (entry, outPath, journal) =>
    new Promise((done) => {
      const env = { ...process.env, SCRIPTC_NO_CACHE: "1", SCRIPTC_TIMING: "1" };
      if (journal) env["SCRIPTC_LOWER_JOURNAL"] = "serial";
      else delete env["SCRIPTC_LOWER_JOURNAL"];
      const proc = spawn(
        process.execPath,
        ["--max-old-space-size=8192", fileURLToPath(import.meta.url), "--child", entry, outPath],
        { stdio: ["ignore", "ignore", "pipe"], env },
      );
      let stderr = "";
      proc.stderr.on("data", (chunk) => (stderr += chunk));
      proc.on("close", (code) => done({ ok: code === 0, stderr }));
    });

  /** The unit-records line SCRIPTC_TIMING prints, or null. */
  const recordStats = (stderr) => {
    const line = stderr.split("\n").find((text) => text.includes('"phase":"unit-records"'));
    return line === undefined ? null : JSON.parse(line.slice(line.indexOf("{")));
  };

  const results = [];
  let next = 0;
  const work = async () => {
    for (;;) {
      const index = next++;
      if (index >= sampled.length) return;
      const entry = sampled[index];
      const name = entry.slice(corpus.length + 1).replaceAll("/", "__");
      const plainPath = join(out, `${name}.plain.ll`);
      const recordedPath = join(out, `${name}.recorded.ll`);
      const plain = await child(entry, plainPath, false);
      const recorded = await child(entry, recordedPath, true);
      const result = { entry, plain: plain.ok, recorded: recorded.ok, stats: null, same: false };
      result.stats = recordStats(recorded.stderr);
      if (plain.ok && recorded.ok)
        result.same = readFileSync(plainPath, "utf8") === readFileSync(recordedPath, "utf8");
      if (result.same || (!plain.ok && !recorded.ok)) {
        rmSync(plainPath, { force: true });
        rmSync(recordedPath, { force: true });
      }
      if (plain.ok !== recorded.ok)
        result.error = (plain.ok ? recorded.stderr : plain.stderr).slice(-2000);
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Number(values.jobs) }, work));
  results.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));

  const built = results.filter((result) => result.plain && result.recorded);
  const differ = built.filter((result) => !result.same);
  const oneMode = results.filter((result) => result.plain !== result.recorded);
  const totals = { units: 0, recorded: 0, unrecorded: 0, reasons: {} };
  for (const { stats } of results) {
    if (stats === null) continue;
    totals.units += stats.units;
    totals.recorded += stats.recorded;
    totals.unrecorded += stats.unrecorded;
    for (const [reason, count] of Object.entries(stats.reasons))
      totals.reasons[reason] = (totals.reasons[reason] ?? 0) + count;
  }
  console.log(
    `${results.length} programs, ${built.length} built, ${differ.length} differ, ${oneMode.length} build in one mode only`,
  );
  console.log(
    `units: ${totals.units}, recorded ${totals.recorded}, without a record ${totals.unrecorded}`,
  );
  for (const [reason, count] of Object.entries(totals.reasons).sort((a, b) => b[1] - a[1]))
    console.log(`  ${reason}: ${count}`);
  for (const result of differ) console.log(`differs: ${result.entry}`);
  for (const result of oneMode)
    console.log(`builds ${result.plain ? "plain" : "recorded"} only: ${result.entry}`);
  console.log(`results: ${join(out, "results.json")}`);
  if (differ.length > 0 || oneMode.length > 0) process.exitCode = 1;
}
