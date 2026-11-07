/** The error a differential harness throws for a child that did not exit
 * normally. execFile's error for a child killed by a signal has no exit code
 * and carries no output of its own: whatever the child wrote to stderr is
 * already inside `message`, and its stdout is gone by then. The signal is the
 * one fact the message drops, and it is what tells a crash from a program that
 * chose a nonzero exit, so the harness reports it. Outputs are appended when a
 * caller's error does carry them. */
export function spawnFailure(err: unknown): Error {
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
  if (Buffer.isBuffer(e.stdout) && e.stdout.length > 0)
    parts.push(`stdout:\n${e.stdout.toString("utf8")}`);
  if (Buffer.isBuffer(e.stderr) && e.stderr.length > 0)
    parts.push(`stderr:\n${e.stderr.toString("utf8")}`);
  return new Error(parts.join("\n"), { cause: err });
}
