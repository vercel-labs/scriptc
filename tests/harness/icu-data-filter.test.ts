/* The runtime pack ships icudt78l.dat without the categories no Intl form
 * reads (ICU_DATA_DROPPED in packages/runtime-pack-common/scripts/
 * icu-inputs.mjs). Every `@requires-icu` corpus program runs under a sweep
 * of locales and time zones three ways: with the pack's data beside it, with
 * ICU's full data file beside it, and in Node. The three outputs must be
 * equal. A later Intl form that reads a dropped category gets ICU's root
 * fallback or a missing-data error from the pack's file and fails here;
 * that change removes the category from ICU_DATA_DROPPED and updates the
 * pinned sha256 and size beside it. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const workDir = join(repoRoot, "node_modules/.cache/scriptc-tests/icu-data-filter");

const icuData = (await import(
  pathToFileURL(join(repoRoot, "packages/runtime-pack-common/scripts/icu-data.mjs")).href
)) as {
  ensureIcuData(cacheDir: string): Promise<string>;
  filterIcuData(bytes: Buffer, keep: (name: string) => boolean): Buffer;
  icuDataItemDropped(name: string): boolean;
};
const icuInputs = (await import(
  pathToFileURL(join(repoRoot, "packages/runtime-pack-common/scripts/icu-inputs.mjs")).href
)) as { ICU_DATA_DROPPED: string[]; ICU_PACK_DATA_SHA256: string };

const LOCALES = [
  "en_US.UTF-8",
  "de_DE.UTF-8",
  "fr_FR.UTF-8",
  "fr_CA.UTF-8",
  "es_MX.UTF-8",
  "pt_BR.UTF-8",
  "it_IT.UTF-8",
  "nl_NL.UTF-8",
  "sv_SE.UTF-8",
  "fi_FI.UTF-8",
  "pl_PL.UTF-8",
  "ru_RU.UTF-8",
  "uk_UA.UTF-8",
  "tr_TR.UTF-8",
  "el_GR.UTF-8",
  "he_IL.UTF-8",
  "ar_EG.UTF-8",
  "ar_SA.UTF-8",
  "fa_IR.UTF-8",
  "ur_PK.UTF-8",
  "hi_IN.UTF-8",
  "bn_BD.UTF-8",
  "mr_IN.UTF-8",
  "ne_NP.UTF-8",
  "ta_IN.UTF-8",
  "th_TH.UTF-8",
  "lo_LA.UTF-8",
  "km_KH.UTF-8",
  "my_MM.UTF-8",
  "ja_JP.UTF-8",
  "ko_KR.UTF-8",
  "zh_CN.UTF-8",
  "zh_TW.UTF-8",
  "zh_HK.UTF-8",
  "vi_VN.UTF-8",
  "id_ID.UTF-8",
  "am_ET.UTF-8",
  "sw_KE.UTF-8",
  "ps_AF.UTF-8",
  "sr_RS.UTF-8",
  "sr_RS@latin",
  "ca_ES@valencia",
  "de_CH.UTF-8",
  "en_IN.UTF-8",
  "en_GB.UTF-8",
  "C.UTF-8",
  "POSIX",
];
const TIME_ZONES = ["UTC", "Asia/Kolkata", "America/New_York"];

const programs = [...globSync(join(corpusDir, "*.ts")), ...globSync(join(corpusDir, "*/main.ts"))]
  .filter((file) =>
    readFileSync(file, "utf8")
      .split("\n", 2)
      .some((line) => /^\/\/ @requires-icu\s*$/.test(line)),
  )
  .sort();

/** The program's `// @env:` variables other than TZ and LC_ALL, which the
 * sweep sets. */
function programEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n", 2)) {
    const m = /^\/\/ @env:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    for (const pair of m[1]!.split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  delete env["TZ"];
  delete env["LC_ALL"];
  return env;
}

async function run(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env: { ...process.env, LANG: "", LC_MESSAGES: "", ...env },
      maxBuffer: 16 << 20,
    });
    return `${stdout}\n--- stderr\n${stderr}`;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return `${e.stdout ?? ""}\n--- stderr\n${e.stderr ?? ""}\n--- exit ${e.code}`;
  }
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]!();
      }
    }),
  );
  return results;
}

const skip = process.platform !== "linux" || process.arch !== "x64";

describe.skipIf(skip)("the runtime pack's filtered ICU data", () => {
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  test("is the pinned full data file without the dropped categories", async () => {
    mkdirSync(workDir, { recursive: true });
    const full = readFileSync(
      await icuData.ensureIcuData(join(repoRoot, "node_modules/.cache/scriptc-icu-data")),
    );
    const filtered = icuData.filterIcuData(full, (name) => !icuData.icuDataItemDropped(name));
    expect(createHash("sha256").update(filtered).digest("hex")).toBe(
      icuInputs.ICU_PACK_DATA_SHA256,
    );
    expect(icuInputs.ICU_DATA_DROPPED.length).toBeGreaterThan(0);
  }, 120_000);

  test.for(programs.map((file) => [file.slice(corpusDir.length + 1), file] as const))(
    "%s gives the same output with the pack's data, the full data and Node",
    async ([rel, file]) => {
      const out = join(workDir, rel.replace(/[/.]/g, "_"));
      const result = await compile(file, {
        outPath: join(out, "filtered", "program"),
        outDir: join(out, "filtered"),
      });
      expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
      if (!result.ok) return;
      const installed = readFileSync(join(dirname(result.binaryPath), "icudt78l.dat"));
      expect(createHash("sha256").update(installed).digest("hex")).toBe(
        icuInputs.ICU_PACK_DATA_SHA256,
      );
      // The same executable with ICU's full data file beside it, where the
      // runtime looks first.
      const fullBinary = join(out, "full", basename(result.binaryPath));
      mkdirSync(dirname(fullBinary), { recursive: true });
      copyFileSync(result.binaryPath, fullBinary);
      copyFileSync(
        await icuData.ensureIcuData(join(repoRoot, "node_modules/.cache/scriptc-icu-data")),
        join(dirname(fullBinary), "icudt78l.dat"),
      );
      const env = programEnv(file);
      const cases = TIME_ZONES.flatMap((tz) =>
        LOCALES.map((locale) => ({ ...env, TZ: tz, LC_ALL: locale })),
      );
      const outputs = await pool(
        cases.map((caseEnv) => async () => ({
          env: `TZ=${caseEnv.TZ} LC_ALL=${caseEnv.LC_ALL}`,
          filtered: await run(result.binaryPath, [], caseEnv),
          full: await run(fullBinary, [], caseEnv),
          node: await run(process.execPath, [file], caseEnv),
        })),
        Math.max(2, availableParallelism() >> 1),
      );
      for (const o of outputs) {
        expect(
          o.filtered,
          `${rel} under ${o.env}: the pack's ICU data answers differently from the full data; ` +
            `an Intl form reads a category in ICU_DATA_DROPPED (${icuInputs.ICU_DATA_DROPPED.join(", ")})`,
        ).toBe(o.full);
        expect(o.full, `${rel} under ${o.env}: scriptc with the full ICU data and Node`).toBe(
          o.node,
        );
      }
    },
    600_000,
  );
});
