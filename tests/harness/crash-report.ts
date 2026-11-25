/* Darwin leaves a crash report for every signal death under
 * ~/Library/Logs/DiagnosticReports (the macOS CI runners keep them). The
 * report names the exception and termination reason, which is the part a
 * harness failure otherwise cannot see: execFile reports a signal with a null
 * code and an empty message. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const REPORT_DIRS = [
  join(homedir(), "Library/Logs/DiagnosticReports"),
  "/Library/Logs/DiagnosticReports",
];

/** ReportCrash writes the file a moment after the process dies, so a lookup
 * polls briefly rather than reading once. */
const REPORT_WAIT_MS = 15000;
const REPORT_POLL_MS = 200;

/** The timestamp ReportCrash ends a report's name with. */
const REPORT_STAMP = /[-_]\d{4}-\d{2}-\d{2}[-_]\d{6}\.(?:ips|crash)$/;

/** Whether a report's file name belongs to `binary`. ReportCrash names the
 * file after the process name, which the kernel cuts to the length of a
 * Darwin task name, so a longer binary name only matches by its prefix. */
export function reportNameMatches(entry: string, binary: string): boolean {
  const name = basename(binary);
  const stamp = REPORT_STAMP.exec(entry);
  if (stamp === null) return entry.includes(name);
  const processName = entry.slice(0, stamp.index);
  return processName.length > 0 && name.slice(0, processName.length) === processName;
}

function newestReport(binary: string, since: number): string | null {
  let newest: { path: string; mtime: number } | null = null;
  for (const dir of REPORT_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".ips") && !entry.endsWith(".crash")) continue;
      if (!reportNameMatches(entry, binary)) continue;
      const path = join(dir, entry);
      try {
        const stats = statSync(path);
        if (stats.mtimeMs < since) continue;
        if (newest === null || stats.mtimeMs > newest.mtime)
          newest = { path, mtime: stats.mtimeMs };
      } catch {
        // The report was rotated away between the listing and the stat.
      }
    }
  }
  return newest?.path ?? null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A sub-object of the payload as the text it appears as, so the line keeps
 * the keys ReportCrash wrote. */
function section(value: unknown): string | undefined {
  if (typeof value === "string") return JSON.stringify(value);
  const entry = record(value);
  return entry === undefined ? undefined : `${JSON.stringify(entry)}`;
}

/** The crashing thread's top frames. A `.ips` payload carries the faulting
 * thread's stack, and the payload's `usedImages` table names the library each
 * frame's `imageIndex` belongs to, which names the library the fault is in
 * even when the frames have no symbols. */
function stack(value: unknown, limit: number): string | undefined {
  const payload = record(value);
  const threads = payload?.["threads"];
  const faulting = payload?.["faultingThread"];
  if (!Array.isArray(threads) || typeof faulting !== "number") return undefined;
  const thread = record(threads[faulting]);
  if (thread === undefined) return undefined;
  const used = payload?.["usedImages"];
  const images = Array.isArray(used) ? used : [];
  const image = (index: unknown): string => {
    if (typeof index !== "number") return "?";
    const name = record(images[index])?.["name"];
    return typeof name === "string" ? name : `image ${index}`;
  };
  const frames = Array.isArray(thread["frames"]) ? thread["frames"] : [];
  const rendered: string[] = [];
  for (const frame of frames.slice(0, limit)) {
    const entry = record(frame);
    if (entry === undefined) continue;
    const symbol = typeof entry["symbol"] === "string" ? entry["symbol"] : "";
    const location = entry["symbolLocation"];
    const offset = entry["imageOffset"];
    let at = symbol;
    if (symbol !== "") {
      if (typeof location === "number") at = `${symbol}+${location}`;
    } else {
      at = typeof offset === "number" ? `+0x${offset.toString(16)}` : "+?";
    }
    rendered.push(`${image(entry["imageIndex"])} ${at}`);
  }
  return rendered.length === 0 ? undefined : `${rendered.join(" <- ")}`;
}

/** The exception, termination reason and crashing stack of a report file's
 * contents, as one line. `.ips` files are a metadata line followed by a JSON
 * payload; older `.crash` files are plain text and keep their head instead. */
export function summarizeReport(name: string, text: string): string {
  const newline = text.indexOf("\n");
  let payload: unknown;
  try {
    payload = newline < 0 ? undefined : JSON.parse(text.slice(newline + 1));
  } catch {
    payload = undefined;
  }
  const entry = record(payload);
  if (entry === undefined) return `${name}: ${text.slice(0, 800)}`;
  const parts = [
    name,
    section(entry["exception"]),
    // Names the region the fault address fell outside of, and how many bytes
    // were left before the next one: a read just past the end of a mapping.
    section(entry["vmRegionInfo"]),
    section(entry["termination"]),
    stack(payload, 12),
  ].filter((part): part is string => part !== undefined);
  return parts.join(" ");
}

function summarize(path: string): string {
  return summarizeReport(basename(path), readFileSync(path, "utf8"));
}

/** What the report directories hold, for a crash whose own report the lookup
 * did not find: a report under a name the lookup did not expect, or none at
 * all because ReportCrash does not run here. */
export function reportDirListing(list: (dir: string) => string[]): string {
  const parts: string[] = [];
  for (const dir of REPORT_DIRS) {
    let entries: string[];
    try {
      entries = list(dir)
        .filter((entry) => entry.endsWith(".ips") || entry.endsWith(".crash"))
        .sort();
    } catch {
      parts.push(`${dir}: unreadable`);
      continue;
    }
    const newest = entries.slice(-3).reverse().join(", ");
    parts.push(`${dir}: ${entries.length} reports${newest === "" ? "" : `, newest ${newest}`}`);
  }
  return parts.join("; ");
}

function listReports(dir: string): string[] {
  return readdirSync(dir);
}

/** The newest crash report for `binary` written after `since` (epoch ms), or
 * null on another platform. A report that does not appear in time is
 * described instead, since a missing report and a report the lookup missed
 * call for different fixes. */
export async function recentCrashReport(binary: string, since: number): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const deadline = Date.now() + REPORT_WAIT_MS;
  for (;;) {
    const path = newestReport(binary, since);
    if (path !== null) {
      try {
        return summarize(path);
      } catch {
        return basename(path);
      }
    }
    if (Date.now() >= deadline) {
      return `no report for ${basename(binary)} in ${REPORT_WAIT_MS} ms; ${reportDirListing(listReports)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_MS));
  }
}
