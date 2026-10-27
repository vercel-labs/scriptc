// Object literals spreading index-signature records whose members are not
// all scalars, or whose spread values are unknown, are checked-dynamic
// objects built like JavaScript's: each spread copies its own keys in
// order, conditional spreads add nothing when they do not apply, and later
// keyed writes land on the same object.
function flatten(obj: unknown, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof obj === "object" && obj !== null) {
    for (const [k, v] of Object.entries(obj)) out[`${prefix}.${k}`] = v;
  }
  return out;
}
function summary(status: string, ms: number, bytes: number | undefined, err: string | undefined) {
  const milestones = { connect: 3, done: 9 };
  const resultTags = {
    "git.fetch.status": status,
    "git.fetch.durationMs": ms,
    ...flatten(milestones, "git.fetch"),
    ...(bytes !== undefined && { "git.fetch.packBytes": bytes }),
    ...(err !== undefined && { "git.fetch.error": err }),
  };
  console.log(JSON.stringify({ event: "git.fetch.summary", version: "v1", ...resultTags }));
}
summary("ok", 12, 100, undefined);
summary("failed", 3, undefined, "boom");
type SendOptions = { method: string; headersTimeout?: number; signal?: AbortSignal };
function send(url: string, options: SendOptions): string {
  return `${url} ${options.method} ${options.headersTimeout ?? "-"} ${options.signal ? options.signal.aborted : "none"}`;
}
function callWith(timeout: number | undefined, attemptTimeout: number | undefined): string {
  return send("u", {
    headersTimeout: timeout,
    method: "GET",
    ...(attemptTimeout && { signal: AbortSignal.timeout(attemptTimeout) }),
  });
}
console.log(callWith(5, 1000));
console.log(callWith(undefined, undefined));
console.log(callWith(5, 0));
function report(tags: string[], from: string, logs: [string, string][]) {
  const ddTags = {
    "errClass.from": from,
    "errClass.tagLabels": Array.from(new Set(tags)).sort(),
    "errClass.tags": "",
    ...tags.reduce((obj: Record<string, boolean>, tag: string) => {
      obj[`errClass.tags.${tag}`] = true;
      return obj;
    }, {}),
    "errClass.logLinesSent": logs.length,
    "errClass.lastRule": "none",
  };
  if (tags.length > 1) {
    ddTags["errClass.lastRule"] = "rule-2";
  }
  for (const tag of ["late"]) {
    // @ts-expect-error -- keys outside the literal's declared ones
    ddTags[`errClass.tags.${tag}`] = true;
  }
  ddTags["errClass.tags"] = tags.join(",");
  console.log(JSON.stringify(ddTags), ddTags["errClass.logLinesSent"] + 1);
}
report(["b", "a"], "build", [["stdout", "x"]]);
report([], "init", []);
