// An object literal that spreads an index-signature record holds every key
// the spread copied, in insertion order, though the checker types it by its
// explicit members only. A conditional spread that does not apply adds no
// key.
function bucket(n: number | undefined): string {
  return n === undefined ? "unknown" : n < 100 ? "small" : "large";
}
function emit(name: string, tags: Record<string, string | number | boolean>): void {
  console.log(name, JSON.stringify(tags), Object.keys(tags).length);
}
function measure(base: Record<string, string>, count: number | undefined, ok: boolean) {
  const metricTags = {
    ...base,
    fileCountBucket: bucket(count),
    status: ok ? "succeeded" : "failed",
  };
  emit("files", metricTags);
  console.log(metricTags.status.toUpperCase(), metricTags.fileCountBucket);
  return metricTags;
}
const base = { plan: "pro", region: "iad1", status: "pending" };
const m = measure(base, 42, true);
console.log(Object.entries(m));
function walker(enable: boolean, metricTags: Record<string, string> = {}) {
  const tags = {
    plan: "unknown",
    ...metricTags,
    largeCliDplPerformance: String(enable),
    walkerFallback: "false",
  };
  tags.walkerFallback = "true";
  console.log(tags, tags.plan);
}
walker(true, { plan: "hobby", extra: "x" });
walker(false);
function counts(tags: Record<string, string>, n: number) {
  const t = { ...tags, attempts: n, retried: n > 1 };
  console.log(t, t.attempts + 1, t.retried);
}
counts({ a: "1" }, 2);
function depthTags(deep: boolean): { depth: number | undefined; kind: "shallow" | "deep"; useDeep: boolean } {
  return { depth: deep ? undefined : 1, kind: deep ? "deep" : "shallow", useDeep: deep };
}
function attempt(base: Record<string, string>, n: number, deep: boolean, bytes: number | undefined) {
  const tags = {
    ...base,
    git_attempt: n,
    repo: "r",
    ...(bytes !== undefined && { packBytes: bytes }),
    ...depthTags(deep),
  };
  console.log(JSON.stringify(tags), Object.keys(tags).join(","), tags.git_attempt, tags.useDeep);
}
attempt({ plan: "pro" }, 1, false, 10);
attempt({ plan: "pro", repo: "x" }, 2, true, undefined);
function addTags(tags: Record<string, unknown>): void {
  console.log(Object.entries(tags).map(([k, v]) => `${k}=${String(v)}`).join(" "));
}
addTags({ ...{ plan: "pro", team: "t" } as Record<string, string>, count: 3, ok: true });
