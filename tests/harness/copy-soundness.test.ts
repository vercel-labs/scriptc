/* Copy soundness: a program that builds with no divergence warning for a
 * conversion behaves as it does under Node.
 *
 * The family (copy-soundness-family.ts) converts values between layouts in
 * every slot the language has and then writes through, compares or reads
 * the result. Each case is judged alone: if the build reports no SC60xx
 * warning on the case's lines, the lines it prints natively must be the
 * lines Node prints. A conversion that starts copying an object the program
 * can tell from its copy, without a warning, fails here.
 *
 * copy-soundness-baseline.json holds what the family measures today:
 * - `aliasableCopies`: per conversion kind, the conversions that copy a
 *   value something else can still reach. The count may only go down, as
 *   kinds learn to keep the object; a rise is a new copy.
 * - `warnedIdentical`: the cases that are warned about and still print what
 *   Node prints (the warning's imprecision). May only go down.
 * - `refused`: the cases the compiler refuses by name, left out of the
 *   programs.
 * - `silent`: the cases known to differ from Node with no warning. Each is
 *   a divergence to fix; the list may only shrink, and a case on it that
 *   stops differing must leave it.
 * Regenerate it with SCRIPTC_UPDATE_COPY_BASELINE=1 after a change that
 * lowers a count, and say why in the commit. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";
import { copySoundnessFamily } from "./copy-soundness-family.js";

const execFileAsync = promisify(execFile);
const baselinePath = join(import.meta.dirname, "copy-soundness-baseline.json");
// Outside the repository: Node strips no types under a node_modules directory.
const workDir = mkdtempSync(join(tmpdir(), "scriptc-copy-soundness-"));
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const update = process.env["SCRIPTC_UPDATE_COPY_BASELINE"] === "1";

interface Baseline {
  aliasableCopies: Record<string, number>;
  warnedIdentical: number;
  refused: string[];
  silent: string[];
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
const programs = copySoundnessFamily(25, new Set(baseline.refused));

const known = new Set(baseline.silent);
const stillSilent = new Set<string>();
const aliasable: Record<string, number> = {};
let warnedIdentical = 0;
let programsRun = 0;

interface Ran {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(cmd: string, args: string[]): Promise<Ran> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : -1,
    };
  }
}

/** The lines of `stdout` by their first token. */
function byTag(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const space = line.indexOf(" ");
    const tag = space < 0 ? line : line.slice(0, space);
    out.set(tag, [...(out.get(tag) ?? []), line]);
  }
  return out;
}

describe(`copy soundness (${programs.length} programs${sanitize ? ", sanitized" : ""})`, () => {
  test.for(programs.map((program) => [program.name, program] as const))(
    "%s",
    async ([, program]) => {
      const file = join(workDir, `${program.name}.ts`);
      writeFileSync(file, program.source);
      const lineOf = (offset: number): number => program.source.slice(0, offset).split("\n").length;

      const analysis = analyze(file);
      expect(
        analysis.coverage.diagnostics.map(
          (d) => `${d.code} line ${lineOf(d.loc.start)}: ${d.message}`,
        ),
        "a case the compiler refuses belongs in the baseline's `refused` list",
      ).toEqual([]);
      for (const fact of analysis.widthCopies ?? [])
        if (fact.aliasable) aliasable[fact.kind] = (aliasable[fact.kind] ?? 0) + 1;
      const warnedLines = new Set(
        (analysis.coverage.divergences ?? [])
          .filter((d) => /^SC60\d\d$/.test(d.code) && d.loc.file === file)
          .map((d) => lineOf(d.loc.start)),
      );

      const outDir = join(workDir, `${program.name}${sanitize ? "-san" : ""}`);
      mkdirSync(outDir, { recursive: true });
      const built = await compile(file, {
        outPath: join(outDir, process.platform === "win32" ? "program.exe" : "program"),
        outDir,
        sanitize,
        backend: "llvm",
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const [node, native] = await Promise.all([
        run(process.execPath, ["--no-warnings", "--experimental-transform-types", file]),
        run(built.binaryPath, []),
      ]);
      expect(node.code, `Node: ${node.stderr}`).toBe(0);
      expect(native.code, `the native program: ${native.stderr}`).toBe(0);
      const expected = byTag(node.stdout);
      const actual = byTag(native.stdout);
      const silent: string[] = [];
      for (const c of program.cases) {
        const want = (expected.get(c.tag) ?? []).join("\n");
        const got = (actual.get(c.tag) ?? []).join("\n");
        expect(want, `${c.id} prints nothing under Node`).not.toBe("");
        const warned = c.lines.some((line) => warnedLines.has(line));
        if (want === got) {
          if (warned) warnedIdentical++;
          continue;
        }
        if (warned) continue;
        if (known.has(c.id)) stillSilent.add(c.id);
        else silent.push(`${c.id}: Node prints '${want}', the native program '${got}'`);
      }
      programsRun++;
      expect(silent, "cases that differ from Node with no divergence warning").toEqual([]);
    },
  );

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
    // The counts describe the whole family: a filtered run measures nothing.
    if (programsRun !== programs.length) return;
    const measured: Baseline = {
      aliasableCopies: Object.fromEntries(Object.entries(aliasable).sort()),
      warnedIdentical,
      refused: baseline.refused,
      silent: baseline.silent.filter((id) => stillSilent.has(id)),
    };
    if (update) {
      writeFileSync(baselinePath, JSON.stringify(measured, null, 2) + "\n");
      return;
    }
    const kinds = new Set([...Object.keys(aliasable), ...Object.keys(baseline.aliasableCopies)]);
    for (const kind of kinds) {
      const now = aliasable[kind] ?? 0;
      const before = baseline.aliasableCopies[kind] ?? 0;
      expect(
        now,
        now > before
          ? `'${kind}' conversions copy an aliasable value in more places than the baseline records: a new copy`
          : `'${kind}' conversions copy in fewer places: lower the baseline (SCRIPTC_UPDATE_COPY_BASELINE=1)`,
      ).toBe(before);
    }
    expect(
      baseline.silent.filter((id) => !stillSilent.has(id)),
      "cases the baseline lists as silent no longer differ without a warning: take them off the list",
    ).toEqual([]);
    expect(
      warnedIdentical,
      warnedIdentical > baseline.warnedIdentical
        ? "more cases are warned about and still match Node: the warning lost precision"
        : "fewer cases are warned about needlessly: lower the baseline (SCRIPTC_UPDATE_COPY_BASELINE=1)",
    ).toBe(baseline.warnedIdentical);
  });
});
