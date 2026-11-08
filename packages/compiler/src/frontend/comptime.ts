/* Compile-time evaluation, the same for every compiler host: TypeScript's
 * command line erases the callback's types, and the evaluator executable (a
 * QuickJS process that holds no host object, native/llvm-codegen/comptime)
 * runs the JavaScript and prints the result as tagged JSON. Only source text
 * goes in and only that text comes back, so nothing the callback builds is
 * ever called or read inside the compiler. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The bounds of one evaluation. The evaluator enforces them. */
export interface ComptimeLimits {
  /** Wall-clock milliseconds. */
  timeoutMs: number;
  /** Megabytes of engine memory. */
  memoryMb: number;
}

/** Why an evaluation produced no value: a limit (`timeout`, `memory`), a
 * thrown value (`thrown`, with its text), or a result or side effect the
 * evaluator refuses by name (`refused`, with the reason). */
export type ComptimeFailureKind = "timeout" | "memory" | "thrown" | "refused";

export class ComptimeFailure extends Error {
  constructor(
    readonly kind: ComptimeFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** Tagged values preserve -0, non-finite numbers, and missing properties so
 * shared result validation sees the value the callback actually returned. */
function decodeComptimeValue(wire: unknown): unknown {
  if (!Array.isArray(wire) || typeof wire[0] !== "string")
    throw new Error("invalid compile-time result");
  const value = wire as unknown[];
  switch (value[0]) {
    case "error": {
      const kind = value[1];
      if (kind === "timeout" || kind === "memory" || kind === "thrown" || kind === "refused")
        throw new ComptimeFailure(kind, String(value[2]));
      break;
    }
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof value[1] === "boolean") return value[1];
      break;
    case "string":
      if (typeof value[1] === "string") return value[1];
      break;
    case "number":
      if (typeof value[1] === "string") return value[1] === "-0" ? -0 : Number(value[1]);
      break;
    case "bigint":
      return BigInt(String(value[1]));
    case "function":
      return () => {};
    case "array":
      if (Array.isArray(value[1])) return value[1].map((item) => decodeComptimeValue(item));
      break;
    case "object": {
      if (!Array.isArray(value[1])) break;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const item of value[1]) {
        if (!Array.isArray(item) || typeof item[0] !== "string")
          throw new Error("invalid compile-time property");
        result[item[0]] = decodeComptimeValue(item[1]);
      }
      return result;
    }
  }
  throw new Error("invalid compile-time result");
}

function comptimeScript(source: string): string {
  return `(${source})();\n`;
}

/** The JavaScript of each callback in `sources`, in order, from one run of
 * TypeScript's command line. Type erasure remains TypeScript's job,
 * including nested annotations, type assertions, generic functions, and
 * enums in closed callbacks. */
function eraseTypes(ts7: string, sources: readonly string[]): string[] {
  const stage = mkdtempSync(join(tmpdir(), "scriptc-comptime-"));
  try {
    const output = join(stage, "output");
    mkdirSync(output);
    const inputs = sources.map((source, index) => {
      const path = join(stage, `eval${index}.ts`);
      writeFileSync(path, comptimeScript(source));
      return path;
    });
    execFileSync(
      ts7,
      [
        "--ignoreConfig",
        "--noCheck",
        "--target",
        "esnext",
        "--module",
        "esnext",
        "--moduleDetection",
        "legacy",
        "--outDir",
        output,
        ...inputs,
      ],
      {
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: 64 * 1024 * 1024,
        cwd: process.cwd(),
        env: process.env,
      },
    );
    return sources.map((_, index) => readFileSync(join(output, `eval${index}.js`), "utf8"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** An evaluator over the TypeScript command line `ts7` and the evaluator
 * executable. `siblings` names the other callbacks of the same source file:
 * their types are erased in the same TypeScript run, so a file costs one
 * such run however many `comptime` calls it holds. */
export function createComptimeEvaluator(
  ts7: string,
  evaluator: () => string,
): (source: string, limits: ComptimeLimits, siblings?: readonly string[]) => unknown {
  const erased = new Map<string, string>();
  return (source, limits, siblings = []) => {
    let script = erased.get(source);
    if (script === undefined) {
      const batch = [source];
      const queued = new Set(batch);
      for (const other of siblings) {
        if (erased.has(other) || queued.has(other)) continue;
        queued.add(other);
        batch.push(other);
      }
      let scripts: string[];
      let converted = batch;
      try {
        scripts = eraseTypes(ts7, batch);
      } catch (error) {
        // A sibling TypeScript rejects must not fail this callback.
        if (batch.length === 1) throw error;
        converted = [source];
        scripts = eraseTypes(ts7, converted);
      }
      for (let index = 0; index < converted.length; index++)
        erased.set(converted[index]!, scripts[index]!);
      script = scripts[0]!;
    }
    const stage = mkdtempSync(join(tmpdir(), "scriptc-comptime-"));
    try {
      const path = join(stage, "eval.js");
      writeFileSync(path, script);
      const result = execFileSync(
        evaluator(),
        [path, String(limits.timeoutMs), String(limits.memoryMb)],
        // The evaluator writes at most 64 MB of result text.
        {
          encoding: "utf8",
          stdio: "pipe",
          maxBuffer: 128 * 1024 * 1024,
          cwd: process.cwd(),
          env: process.env,
        },
      );
      return decodeComptimeValue(JSON.parse(result));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  };
}
