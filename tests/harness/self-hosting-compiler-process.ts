import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AnalyzeOptions,
  CompileOptions,
  CompileExecutableResult,
  CoverageInput,
} from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const api = new URL("../../packages/compiler/src/index.ts", import.meta.url).href;

// Large synchronous frontend passes must leave Vitest's worker RPC responsive.
// Execute the source API in a child and return only JSON-compatible results.
async function compilerProcess(
  operation: "analyze" | "compile",
  entry: string,
  options: object,
  control: { timeout?: number } = {},
): Promise<unknown> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { analyze, compile } from ${JSON.stringify(api)};
     const options = JSON.parse(process.argv[3]);
     const result = process.argv[1] === 'analyze'
       ? analyze(process.argv[2], options).coverage
       : await compile(process.argv[2], options);
     console.log(JSON.stringify(result, (key, value) => key === 'sourceTexts' ? undefined : value));`,
      operation,
      entry,
      JSON.stringify(options),
    ],
    {
      cwd: root,
      // The caller's test budget: the child must outlive the band the test
      // allows, or the exec would kill a build the test still times.
      timeout: control.timeout ?? 300_000,
      // The result carries the build's warnings, and the compiler's own
      // source has several thousand SC6001 (frontend/lowering/width-copies.ts).
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (stderr !== "") throw new Error(stderr);
  return JSON.parse(stdout);
}

export async function analyzeInChild(
  entry: string,
  options: AnalyzeOptions,
): Promise<CoverageInput> {
  return (await compilerProcess("analyze", entry, options)) as CoverageInput;
}

type ExecutableResult =
  | Extract<CompileExecutableResult, { ok: true }>
  | Omit<Extract<CompileExecutableResult, { ok: false }>, "sourceTexts">;

export async function compileInChild(
  entry: string,
  options: CompileOptions,
  control: { timeout?: number } = {},
): Promise<ExecutableResult> {
  return (await compilerProcess("compile", entry, options, control)) as ExecutableResult;
}
