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
const REPORT_WAIT_MS = 5000;
const REPORT_POLL_MS = 200;

function newestReport(binary: string, since: number): string | null {
  const name = basename(binary);
  let newest: { path: string; mtime: number } | null = null;
  for (const dir of REPORT_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.includes(name)) continue;
      if (!entry.endsWith(".ips") && !entry.endsWith(".crash")) continue;
      const path = join(dir, entry);
      try {
        const stats = statSync(path);
        if (stats.mtimeMs < since) continue;
        if (newest === null || stats.mtimeMs > newest.mtime) newest = { path, mtime: stats.mtimeMs };
      } catch {
        // The report was rotated away between the listing and the stat.
      }
    }
  }
  return newest?.path ?? null;
}

/** The exception and termination reason of a report, as one line. `.ips`
 * files are a metadata line followed by the payload; older `.crash` files are
 * plain text and keep their head instead. */
function summarize(path: string): string {
  const text = readFileSync(path, "utf8");
  const payload = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
  const exception = /"exception"\s*:\s*\{[^}]*\}/.exec(payload)?.[0];
  const termination = /"termination"\s*:\s*\{[^}]*\}/.exec(payload)?.[0];
  const parts = [basename(path), exception, termination].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 1 ? parts.join(" ") : `${basename(path)}: ${text.slice(0, 800)}`;
}

/** The newest crash report for `binary` written after `since` (epoch ms), or
 * null on another platform or when none appears in time. */
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
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_MS));
  }
}
