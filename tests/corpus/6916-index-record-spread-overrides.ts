// Spreading a fixed-shape record into an index-signature record: the
// spread's keys enter in declaration order, and a field whose type does
// not fit the index slot is valid when a later property overrides it
// (its key keeps the spread's position, the override supplies the value).
interface FailureTags {
  phase: string;
  httpStatus: number;
  retried: boolean;
  region: string;
}
interface Counts {
  zeta: number;
  alpha: number;
  mid: number;
}

function emit(name: string, tags: { [key: string]: string }): void {
  const parts: string[] = [];
  for (const key of Object.keys(tags)) parts.push(key + ":" + tags[key]);
  console.log(name, parts.join(","), JSON.stringify(tags));
}

const tags: FailureTags = { phase: "fetch", httpStatus: 503, retried: true, region: "iad1" };
for (let attempt = 1; attempt <= 2; attempt++) {
  emit("attempt_failed", {
    ...tags,
    attempt: String(attempt),
    httpStatus: String(tags.httpStatus),
    retried: tags.retried ? "yes" : "no",
  });
}

const base: Record<string, string> = { team: "core", owner: "infra" };
emit("queue", { ...base, owner: "builds", shard: "7" });
emit("size", { ...base });

const counts: Counts = { zeta: 3, alpha: 1, mid: 2 };
const scores: Record<string, number> = { ...counts, alpha: 10 };
console.log(Object.keys(scores).join(","), JSON.stringify(scores));
const labels: Record<string, string> = { first: "a", ...{ zeta: "z", alpha: "a" }, last: "l" };
console.log(Object.entries(labels).map(([k, v]) => k + "=" + v).join(" "));
const flags: { [key: string]: boolean } = { ...counts, mid: true, zeta: false, alpha: true };
console.log(JSON.stringify(flags));

// A source whose values are built in another order than its interface
// declares: the spread follows the order the values are built in.
interface Span {
  start: number;
  end: number;
  label?: string;
}
function span(start: number, size: number, label?: string): Span {
  return label === undefined ? { end: start + size, start } : { label, end: start + size, start };
}
const spans: Record<string, number | string> = { ...span(1, 4), step: 2 };
console.log(Object.keys(spans).join(","), JSON.stringify(spans));
const named: Record<string, number | string> = { first: 0, ...span(5, 2, "w"), last: 9 };
console.log(Object.keys(named).join(","), JSON.stringify(named));
const both: Record<string, number> = { ...counts, ...{ end: 3, start: 1 }, mid: 7 };
console.log(Object.keys(both).join(","), JSON.stringify(both));
