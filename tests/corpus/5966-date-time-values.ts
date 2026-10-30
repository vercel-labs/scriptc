// Date locals that are only read for their time value (method receivers,
// String() and template operands, relational and string `+` operands,
// `new Date(d)`) print and compare as Dates; locals whose identity a use
// can observe keep it.
export {};
process.env.TZ = "America/New_York";

function describe(ms: number): string {
  const d = new Date(ms);
  const later = new Date(ms + 3_600_000);
  const copy = new Date(d);
  return [
    d.toISOString(),
    d.toUTCString(),
    String(d),
    `${later}`,
    "at " + d,
    d < later,
    later >= d,
    d.getHours(),
    d.getUTCDay(),
    d.getTimezoneOffset(),
    copy.getTime() === d.getTime(),
    d.toJSON(),
  ].join(" | ");
}
console.log(describe(Date.UTC(2026, 2, 8, 6, 30)));
console.log(describe(Date.UTC(2026, 10, 1, 5, 30)));
function invalid(): string {
  const d = new Date(NaN);
  return [String(d), d.getTime(), String(d.toJSON()), d < new Date(0), `${d}`].join(" | ");
}
console.log(invalid());

function sum(days: number): number {
  let total = 0;
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
    total += day.getUTCDate() + day.getUTCMonth() + day.toISOString().length;
  }
  return total;
}
console.log(sum(400));

// Identity-observing uses keep the Date object.
const kept: Date[] = [];
function identities(ms: number): string {
  const a = new Date(ms);
  const b = a;
  const stored = new Date(ms);
  kept.push(stored);
  const captured = new Date(ms);
  const read = (): number => captured.getTime();
  const passed = new Date(ms);
  return [a === b, kept.includes(stored), kept[0] === stored, read(), same(passed, passed)].join(",");
}
function same(x: Date, y: Date): boolean {
  return x === y;
}
console.log(identities(5));
const held: unknown = kept[0];
console.log(held instanceof Date, (held as Date) === kept[0]);

// Dates in blocks and loops at module level, read for their time value or
// kept, stored and captured.
const moduleKept: Date[] = [];
let moduleTotal = "";
for (let i = 0; i < 3; i++) {
  const read = new Date(Date.UTC(2026, 2, 8 + i, 6, 30));
  const kept = new Date(read.getTime());
  moduleKept.push(kept);
  moduleTotal += `${read.toISOString()} ${read.getHours()} ${String(read)}\n`;
}
{
  const block = new Date(Date.UTC(2026, 10, 1, 5, 59));
  const captured = new Date(block);
  const later = (): string => captured.toISOString();
  moduleTotal += `${block.getTimezoneOffset()} ${later()} ${captured === moduleKept[0]}`;
}
console.log(moduleTotal, moduleKept.map((d) => d.getUTCDate()).join(","));
