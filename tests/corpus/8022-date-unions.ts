// Dates in unions with other arms: Date | string, Date | number and
// Date | a record, narrowed with instanceof and typeof, in arrays, Map
// values, optional fields and function results. A Date arm keeps its
// identity, so a setter through a union-typed alias changes the original.
export {};
process.env.TZ = "UTC";

type When = Date | string | number;

function describe(when: When): string {
  if (when instanceof Date) return `date ${when.toISOString()}`;
  if (typeof when === "string") return `text ${when}`;
  return `ms ${when}`;
}

function normalize(when: When): Date {
  return when instanceof Date ? when : new Date(when);
}

const fixed = new Date(Date.UTC(2026, 9, 23));
const values: When[] = [fixed, "2026-01-02T03:04:05Z", 0, new Date(Number.NaN)];
for (const value of values) {
  const text = value instanceof Date && Number.isNaN(value.getTime()) ? "invalid" : describe(value);
  console.log(text);
}
console.log(normalize(fixed) === fixed, normalize("2000-01-01").getUTCFullYear(), normalize(1e12).getUTCFullYear());

const held: When = fixed;
if (held instanceof Date) held.setUTCHours(12);
console.log(fixed.getUTCHours(), held === fixed);

type Stamp = Date | { label: string; at: number };
const stamps: Stamp[] = [fixed, { label: "start", at: 5 }];
for (const stamp of stamps) {
  console.log(stamp instanceof Date ? stamp.getUTCDate() : `${stamp.label}@${stamp.at}`);
}

const byKey = new Map<string, Date | string>();
byKey.set("a", fixed);
byKey.set("b", "later");
for (const [key, value] of byKey) console.log(key, value instanceof Date ? value.getTime() : value);

interface Task {
  name: string;
  due?: Date;
  done: Date | null;
}
const tasks: Task[] = [
  { name: "write", due: fixed, done: null },
  { name: "ship", done: new Date(Date.UTC(2026, 11, 1)) },
];
for (const task of tasks) {
  const due = task.due ? task.due.toISOString().slice(0, 10) : "none";
  const done = task.done === null ? "open" : task.done.toISOString().slice(0, 10);
  console.log(task.name, due, done);
}
tasks[0]!.due!.setUTCDate(30);
console.log(fixed.getUTCDate(), tasks[0]!.due === fixed);

function latest(dates: (Date | undefined)[]): Date | string {
  let best: Date | undefined;
  for (const date of dates) if (date && (best === undefined || date > best)) best = date;
  return best ?? "none";
}
const found = latest([undefined, fixed, new Date(0)]);
console.log(found === fixed, latest([]));

console.log(JSON.stringify({ values, stamps }));
