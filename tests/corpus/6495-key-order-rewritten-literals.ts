// Object literals keep their own key order through JSON.stringify when the
// function that builds them is rewritten by a later lowering pass (here a
// catch block that hands the caught value to an `unknown` parameter). The
// declared type lists the keys in another order; Node writes the literal's.
interface StatusBody {
  pool?: string;
  cpuModel?: string;
  cellId?: string;
  hiveId?: string;
  cluster?: string;
  commit?: string;
  idleSince?: number;
}
interface PatchBody {
  readyState: string;
  status: StatusBody;
}

function describe(value: unknown): string {
  return value instanceof Error ? `Error(${value.message})` : String(value);
}

function send(path: string, body: string): string {
  return `${path} ${body}`;
}

function write(status: StatusBody): string {
  return JSON.stringify(status);
}

function report(commit: string, idleSince: number | undefined, fail: boolean): string[] {
  const lines: string[] = [];
  try {
    if (fail) throw new Error("probe failed");
  } catch (e) {
    lines.push(`caught ${describe(e)}`);
  }
  lines.push(
    send(
      "/patch",
      JSON.stringify({
        readyState: "DOWNLOADING",
        status: { cellId: "c1", cluster: "k1", commit, cpuModel: "m1", hiveId: "h1", idleSince },
      } satisfies PatchBody),
    ),
  );
  lines.push(write({ cellId: "c2", cluster: "k2", commit, cpuModel: "m2", hiveId: "h2" }));
  const body = { hiveId: "h3", commit, cellId: "c3" } satisfies StatusBody;
  lines.push(send("/status", JSON.stringify(body)), Object.keys(body).join(","));
  return lines;
}

for (const line of report("abc", 5, true)) console.log(line);
for (const line of report("def", undefined, false)) console.log(line);
