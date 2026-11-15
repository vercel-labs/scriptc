/** How much of one stream the failure quotes. A crash prints a few lines; a
 * runaway child should not push the diagnosis out of the log. */
const STREAM_LIMIT = 4000;

function head(stream: Buffer): string {
  const text = stream.toString("utf8");
  return text.length > STREAM_LIMIT
    ? `${text.slice(0, STREAM_LIMIT)}… (${stream.length} bytes)`
    : text;
}

/** The error a differential harness throws for a child that did not exit
 * normally. execFile's error for a child killed by a signal has no exit code
 * and carries no output of its own: whatever the child wrote to stderr is
 * already inside `message`, and its stdout is gone by then. The signal is the
 * one fact the message drops, and it is what tells a crash from a program that
 * chose a nonzero exit, so the harness reports it. Outputs are appended when a
 * caller's error does carry them, and so is `crash`, the summary of the crash
 * report darwin leaves for a signal death (crash-report.ts), when the caller
 * found one. */
export function spawnFailure(err: unknown, crash?: string | null): Error {
  const e = err as {
    message?: string;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const signal = typeof e.signal === "string" ? e.signal : undefined;
  const parts = [
    `${e.message ?? "spawn failed"}${signal !== undefined ? ` (signal ${signal})` : ""}`,
  ];
  if (Buffer.isBuffer(e.stdout) && e.stdout.length > 0) parts.push(`stdout:\n${head(e.stdout)}`);
  if (Buffer.isBuffer(e.stderr) && e.stderr.length > 0) parts.push(`stderr:\n${head(e.stderr)}`);
  if (crash !== undefined && crash !== null) parts.push(`crash report ${crash}`);
  return new Error(parts.join("\n"), { cause: err });
}
