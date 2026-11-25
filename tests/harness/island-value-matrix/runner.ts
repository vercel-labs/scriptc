/* Runs one program of the island value-crossing matrix (matrix.ts) under
 * Node and as a native binary, and classifies every observation.
 *
 * Each observation is one source line, so the runner can isolate what goes
 * wrong: a line the compiler refuses is dropped (with the lines that use
 * what it binds) and the program is built again, and a line the native
 * program dies on (a signal, an uncaught error, no end) is dropped the same
 * way. Node then runs the program that remains, and the two outputs are
 * compared label by label. */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile } from "@scriptc/compiler";
import { mainSource, type Cell } from "./matrix.js";

export type Status =
  | "match"
  /** Both sides throw the same error class with different text. */
  | "message"
  /** The compiler refuses the line by name. */
  | "refused"
  /** The line does not typecheck: the generator's or a declaration's mistake. */
  | "tserror"
  /** The native program throws a named "not supported yet" error. */
  | "unsupported"
  /** The native program throws a catchable error where Node answers. */
  | "throws"
  /** The native program dies of an uncaught error here; Node goes on. */
  | "exit"
  /** The native program answers silently and differently. */
  | "wrong"
  /** The native program does not finish. */
  | "hang"
  /** The native program dies of a signal. */
  | "crash"
  /** The line needs a binding that was dropped. */
  | "dependent";

export interface Observation {
  status: Status;
  node?: string;
  native?: string;
  /** For a line of facts (`a=1 ;; b=2`): the facts that differ. */
  facts?: { fact: string; status: Status; node?: string; native?: string }[];
  code?: string;
  message?: string;
  /** The line binds the value its part of the program exists for. */
  setup?: boolean;
}

export interface ProgramResult {
  id: string;
  /** Every labelled line that is not a match. */
  observations: Record<string, Observation>;
  builds: number;
  /** What kept the program from being classified at all. */
  failure: string | null;
}

const SEVERITY: Record<Status, number> = {
  match: 0,
  dependent: 0,
  message: 1,
  refused: 2,
  tserror: 2,
  unsupported: 3,
  throws: 4,
  exit: 6,
  wrong: 7,
  hang: 8,
  crash: 9,
};

interface Run {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer: 256 << 20, encoding: "utf8", killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const e = error as
          | (Error & { code?: number | string; signal?: string; killed?: boolean })
          | null;
        resolve({
          code: e === null ? 0 : typeof e.code === "number" ? e.code : null,
          signal: e?.signal ?? null,
          stdout,
          stderr,
          timedOut: e?.killed === true,
        });
      },
    );
  });
}

function labelled(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(": ");
    if (at <= 0) continue;
    const label = line.slice(0, at);
    if (!out.has(label)) out.set(label, line.slice(at + 2));
  }
  return out;
}

const errorClass = (s: string): string | null => /^!(\w+)(?::|$)/.exec(s)?.[1] ?? null;

/** One value against the other: each is a formatted value or `!Class: message`. */
function compareValue(node: string | undefined, native: string | undefined): Status {
  if (node === native) return "match";
  if (node === undefined || native === undefined) return "wrong";
  const thrown = errorClass(native);
  if (thrown !== null && thrown === errorClass(node)) return "message";
  if (thrown !== null && /not supported yet/.test(native)) return "unsupported";
  if (thrown !== null && errorClass(node) === null) return "throws";
  return "wrong";
}

function compare(node: string, native: string): Observation {
  if (node === native) return { status: "match" };
  // A line of facts compares fact by fact, unless one side threw before it
  // could answer any.
  const whole = node.startsWith("!") || native.startsWith("!");
  if (!whole && /^\w+=/.test(node)) {
    const parse = (s: string): Map<string, string> => {
      const m = new Map<string, string>();
      for (const part of s.split(" ;; ")) {
        const at = part.indexOf("=");
        m.set(at < 0 ? part : part.slice(0, at), at < 0 ? "" : part.slice(at + 1));
      }
      return m;
    };
    const a = parse(node);
    const b = parse(native);
    const facts: NonNullable<Observation["facts"]> = [];
    let status: Status = "match";
    for (const fact of new Set([...a.keys(), ...b.keys()])) {
      const st = compareValue(a.get(fact), b.get(fact));
      if (st === "match") continue;
      facts.push({ fact, status: st, node: a.get(fact), native: b.get(fact) });
      if (SEVERITY[st] > SEVERITY[status]) status = st;
    }
    if (facts.length > 0) return { status, node, native, facts };
  }
  return { status: compareValue(node, native), node, native };
}

/** The pinned form of an observation: its status, the refusal's code, or
 * the facts that differ. */
export function pin(o: Observation): string {
  if (o.status === "refused" || o.status === "tserror") return `${o.status}:${o.code ?? "?"}`;
  if (o.facts !== undefined)
    return o.facts
      .map((f) => `${f.fact}=${f.status}`)
      .sort()
      .join(",");
  return o.status;
}

export interface RunOptions {
  /** Where the program's files and outputs go. */
  dir: string;
  sanitize: boolean;
  /** Labels of lines to leave out from the start: the ones the native
   * program is known to die on, which only a rebuild per line can find. */
  drop?: ReadonlySet<string>;
}

export async function runProgram(cell: Cell, options: RunOptions): Promise<ProgramResult> {
  const { dir } = options;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(cell.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const lines = cell.lines;
  const entry = join(dir, "main.ts");
  const dropped = new Map<number, Observation>();
  // Helper functions and the lines inside a reader print nothing themselves.
  const printed = (n: number): boolean => {
    const label = lines[n]!.label;
    if (label === undefined) return false;
    const bare = label.slice(label.indexOf("/") + 1);
    return !bare.startsWith("helper.") && !bare.startsWith("cb.");
  };
  const drop = (n: number, why: Observation): void => {
    if (dropped.has(n)) return;
    dropped.set(n, why);
    const name = lines[n]!.defines;
    if (name === undefined) return;
    const uses = new RegExp(`\\b${name}\\b`);
    lines.forEach((line, m) => {
      if (m !== n && line.label !== undefined && uses.test(line.code))
        drop(m, { status: "dependent" });
    });
  };
  lines.forEach((line, n) => {
    if (line.label !== undefined && options.drop?.has(line.label) === true)
      drop(n, { status: "crash" });
  });
  const source = (): string => mainSource(lines, new Set(dropped.keys()));

  let builds = 0;
  let native: Run | null = null;
  let nativeOut = new Map<string, string>();
  let failure: string | null = null;
  for (;;) {
    if (builds >= 40) {
      failure = "gave up after 40 builds";
      break;
    }
    const text = source();
    writeFileSync(entry, text);
    builds++;
    const result = await compile(entry, {
      outPath: join(dir, "main"),
      outDir: dir,
      sanitize: options.sanitize,
    });
    if (!result.ok) {
      let progress = false;
      const elsewhere: string[] = [];
      for (const d of result.diagnostics) {
        const n = d.loc.file === entry ? text.slice(0, d.loc.start).split("\n").length - 1 : -1;
        const line = lines[n];
        if (line?.label !== undefined) {
          if (dropped.has(n)) continue;
          drop(n, {
            status: d.code === "SC0001" ? "tserror" : "refused",
            code: d.code,
            message: d.message,
          });
          progress = true;
        } else {
          elsewhere.push(`${d.code} at ${d.loc.file}:${n + 1}: ${d.message}`);
        }
      }
      if (progress) continue;
      failure = `the build fails outside the observations: ${elsewhere.join(" | ").slice(0, 2000)}`;
      break;
    }
    native = await run(result.binaryPath, [], dir, 60_000);
    nativeOut = labelled(native.stdout);
    if (!native.timedOut && native.signal === null && native.code === 0) break;
    const culprit = lines.findIndex(
      (line, n) => printed(n) && !dropped.has(n) && !nativeOut.has(line.label!),
    );
    if (culprit < 0) break;
    drop(culprit, {
      status: native.timedOut ? "hang" : native.signal !== null ? "crash" : "exit",
      message:
        (native.signal !== null ? `signal ${native.signal}; ` : `exit ${native.code}; `) +
        native.stderr.trim().split("\n").slice(0, 4).join(" | ").slice(0, 600),
    });
  }
  writeFileSync(entry, source());
  const node = await run("node", ["main.ts"], dir, 120_000);
  const nodeOut = labelled(node.stdout);
  if (failure === null && node.code !== 0)
    failure = `Node exits ${node.code ?? node.signal}: ${node.stderr.slice(-600)}`;

  const observations: Record<string, Observation> = {};
  lines.forEach((line, n) => {
    if (line.label === undefined) return;
    const why = dropped.get(n);
    if (why !== undefined) {
      if (why.status !== "dependent")
        observations[line.label] = line.setup === true ? { ...why, setup: true } : why;
      return;
    }
    if (!printed(n) || failure !== null) return;
    const a = nodeOut.get(line.label);
    const b = nativeOut.get(line.label);
    if (a === undefined || b === undefined) {
      observations[line.label] = { status: "wrong", node: a, native: b };
      return;
    }
    const o = compare(a, b);
    if (o.status !== "match") observations[line.label] = o;
  });
  return { id: cell.id, observations, builds, failure };
}
