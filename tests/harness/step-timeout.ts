/* Deadlines for the individual steps of a corpus case.
 *
 * A case is several steps — the Node oracle, one compile per optimization
 * mode, one run of each compiled binary — and vitest's test timeout reports
 * the case, not the step that stalled, while the processes the step started
 * keep running. A step deadline puts a bound on one step and, when it
 * expires, names the step and every process still alive under the test, so a
 * hang is identifiable from the failure message alone.
 *
 * SCRIPTC_STEP_TIMEOUT_MS tunes the default deadline (240 s, inside the
 * harnesses' 300 s test timeout).
 */
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";

const stepTimeoutEnv = Number(process.env["SCRIPTC_STEP_TIMEOUT_MS"]);
export const STEP_TIMEOUT_MS =
  Number.isFinite(stepTimeoutEnv) && stepTimeoutEnv > 0 ? stepTimeoutEnv : 240_000;

/** Registers a child process the step started, so the deadline can name it. */
export type Track = (child: ChildProcess) => void;

/** How much of one stream the abnormal-exit message quotes. A crash prints a
 * few lines; a runaway child should not push the diagnosis out of the log. */
const ABNORMAL_EXIT_LIMIT = 4000;

function quoted(value: unknown): string {
  const text = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : typeof value === "string"
      ? value
      : null;
  if (text === null) return "<none>";
  return JSON.stringify(
    text.length > ABNORMAL_EXIT_LIMIT
      ? `${text.slice(0, ABNORMAL_EXIT_LIMIT)}… (${text.length} bytes)`
      : text,
  );
}

/** The failure message for a step child that did not exit on its own terms.
 * `execFile` reports a signal death with a null `code` and a message that stops
 * at the command line, so the failure would name only the binary. Keeping the
 * signal and what crossed either stream makes a crash diagnosable from the log
 * alone — the stdout shows how far the program got. `crash` carries the darwin
 * crash report's exception line when one was found. */
export function abnormalExitMessage(cmd: string, err: unknown, crash?: string | null): string {
  const e = (err ?? {}) as {
    code?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return (
    `${cmd} did not exit normally (signal ${String(e.signal ?? "none")}, ` +
    `code ${String(e.code ?? "none")}):\n` +
    `  stdout ${quoted(e.stdout)}\n  stderr ${quoted(e.stderr)}` +
    (crash === undefined || crash === null ? "" : `\n  crash report ${crash}`)
  );
}

interface ProcessRow {
  pid: number;
  ppid: number;
  state: string;
  command: string;
}

/** The machine's process table, as pid/parent/state/command rows. Empty where
 * `ps` is unavailable (Windows): tracked children are still reported, only
 * without their state. */
function processTable(): ProcessRow[] {
  if (process.platform === "win32") return [];
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,args="], {
    encoding: "utf8",
    maxBuffer: 8 << 20,
  });
  if (listing.error !== undefined || typeof listing.stdout !== "string") return [];
  const rows: ProcessRow[] = [];
  for (const line of listing.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    // `ps` runs as this process's child while it lists itself.
    if (Number(m[1]) === listing.pid) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), state: m[3]!, command: m[4]! });
  }
  return rows;
}

/** Every process below `root`, parents before children. */
function descendants(root: number, table: ProcessRow[]): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const list = children.get(row.ppid);
    if (list === undefined) children.set(row.ppid, [row]);
    else list.push(row);
  }
  const out: ProcessRow[] = [];
  const pending = [...(children.get(root) ?? [])];
  while (pending.length > 0) {
    const row = pending.shift()!;
    out.push(row);
    pending.push(...(children.get(row.pid) ?? []));
  }
  return out;
}

function describeRow(row: ProcessRow): string {
  return `pid ${row.pid} (state ${row.state}) ${row.command}`;
}

/** Every live process below the test, as the message lists them — the step's
 * registered children first, then the rest of the tree — with the pids to
 * stop. A compile starts its LLVM helper itself, so most of a compile step's
 * processes are ones no callback ever registers. */
function liveProcesses(tracked: ChildProcess[]): { rows: string[]; pids: number[] } {
  const table = processTable();
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const alive = (child: ChildProcess): boolean =>
    child.exitCode === null && child.signalCode === null;
  const rows: string[] = [];
  const pids: number[] = [];
  const seen = new Set<number>();
  for (const child of tracked) {
    if (child.pid === undefined || !alive(child) || seen.has(child.pid)) continue;
    seen.add(child.pid);
    pids.push(child.pid);
    const row = byPid.get(child.pid);
    rows.push(
      row === undefined
        ? `pid ${child.pid} ${[child.spawnfile, ...child.spawnargs].join(" ")}`
        : describeRow(row),
    );
  }
  for (const row of descendants(process.pid, table)) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    rows.push(describeRow(row));
    pids.push(row.pid);
  }
  return { rows, pids };
}

/** The failure message for a step that outlived its deadline: the step, how
 * long it ran, and each live process below the test. */
function timeoutMessage(label: string, timeoutMs: number, rows: string[]): string {
  const suffix =
    rows.length === 0
      ? "no process remains under the test"
      : `still running:\n  ${rows.join("\n  ")}`;
  return `${label}: no result after ${timeoutMs} ms; ${suffix}`;
}

/** Stops the processes an expired step still had running. Killing only the
 * children a step registered would leave a compile's helper behind: the
 * harness never starts it, so it is never registered, and it would outlive
 * the case. */
function stop(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone: the step or its parent reaped it first.
    }
  }
}

/** Runs one step of a case under its own deadline. The step reports each
 * child it spawns to `track`, so a timeout names them; a step that expires
 * stops everything the test still has running, registered or not — including
 * the processes a compile starts on its own — since the case has failed and
 * nothing awaits them. */
export async function runStep<T>(
  label: string,
  step: (track: Track) => Promise<T>,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<T> {
  const tracked: ChildProcess[] = [];
  let handle: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      // Describe the tree before stopping it, so the message reports what
      // the deadline actually caught.
      const { rows, pids } = liveProcesses(tracked);
      stop(pids);
      reject(new Error(timeoutMessage(label, timeoutMs, rows)));
    }, timeoutMs);
    // A resolved case must not keep the worker alive for the deadline.
    timer.unref();
    handle = timer;
  });
  try {
    return await Promise.race([step((child) => tracked.push(child)), deadline]);
  } finally {
    clearTimeout(handle);
  }
}
