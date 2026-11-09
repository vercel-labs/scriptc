// A union whose arms share a discriminant value takes a value from a
// narrower union when the arms that share the value are one record
// (union-classes.ts): each `kind` the source holds then has one owner, and
// the members only some of the arms declare stay absent.
type Report = { kind: "calm" } | { kind: "gust"; knots: number } | { kind: "squall"; knots: number; bearing: string };

// What the log keeps. A gust is kept with room for its length, and once it
// has been looked at, with room for the reviewer too: two arms under one
// `kind`, and a reported gust fits both.
type Logged =
  | { kind: "calm" }
  | { kind: "gust"; knots: number; seconds?: number }
  | { kind: "gust"; knots: number; seconds?: number; reviewer?: string }
  | { kind: "squall"; knots: number; bearing: string; seconds?: number };

const log: Logged[] = [];

function keep(entry: Logged): string {
  log.push(entry);
  if (entry.kind === "calm") return "calm";
  const timed = entry.seconds === undefined ? "untimed" : `${entry.seconds}s`;
  return `${entry.kind} ${entry.knots}kn ${timed} [${Object.keys(entry).join(" ")}]`;
}

// A value of the narrower union enters the wider one.
function record(report: Report): string {
  return keep(report);
}

const reports: Report[] = [
  { kind: "squall", knots: 41, bearing: "NW" },
  { kind: "calm" },
  { kind: "gust", knots: 23 },
];
console.log(reports.map(record).join("; "));
console.log(record({ kind: "gust", knots: 30 }));

// The wider union's own values, beside them.
console.log(keep({ kind: "gust", knots: 28, seconds: 9 }));
console.log(keep({ kind: "gust", knots: 35, seconds: 4, reviewer: "duty officer" }));
console.log(keep({ kind: "squall", knots: 52, bearing: "N", seconds: 140 }));

// Every value kept reads back by its `kind`, with the members it was given and no others.
let longest = 0;
for (const entry of log) {
  if (entry.kind === "calm") continue;
  if (entry.seconds !== undefined && entry.seconds > longest) longest = entry.seconds;
  if (entry.kind === "gust") console.log(entry.knots, "reviewer" in entry ? entry.reviewer : "not reviewed", "seconds" in entry);
}
console.log(longest, JSON.stringify(log));
