// Date setters and evaluation order: a setter called without arguments
// makes the Date invalid, an argument that calls setTime on the same
// Date subclass instance is seen by the setter, a comparison or
// concatenation reads its left Date after the right side runs a setter,
// and toJSON reads its Date after an argument runs a setter.
export {};
process.env.TZ = "UTC";

const show = (label: string, d: Date): void => {
  console.log(label, d.getTime(), Number.isNaN(d.getTime()) ? "invalid" : d.toISOString());
};

// No arguments: the first argument is undefined, so NaN.
const local = new Date(Date.UTC(2026, 5, 15, 9, 30));
// @ts-expect-error: the first argument is required
console.log(local.setHours(), Number.isNaN(local.getTime()));
const utc = new Date(Date.UTC(2026, 5, 15, 9, 30));
// @ts-expect-error: the first argument is required
console.log(utc.setUTCMonth(), utc.setUTCFullYear(2020));
show("utc after", utc);
const kept = new Date(Date.UTC(2026, 5, 15));
const keep = kept;
// @ts-expect-error: the first argument is required
console.log(keep.setMinutes(), kept.getTime());

class Stamp extends Date {
  label(): string {
    return `stamp ${this.toISOString()}`;
  }
}
const stamp = new Stamp(Date.UTC(2026, 0, 1));
// @ts-expect-error: the first argument is required
console.log(stamp.setSeconds(), Number.isNaN(stamp.getTime()));
stamp.setTime(Date.UTC(2026, 0, 2));
// @ts-expect-error: the first argument is required
console.log(stamp.setUTCDate(), stamp.setUTCFullYear(2024, 1, 29), stamp.label());

// An argument that calls setTime on the same instance.
const moved = new Stamp(Date.UTC(2026, 3, 10, 12));
console.log(moved.setUTCHours((moved.setTime(Date.UTC(2000, 0, 1)), 5)), moved.label());
const plain = new Date(Date.UTC(2026, 3, 10, 12));
console.log(plain.setUTCMinutes((plain.setTime(Date.UTC(2001, 0, 1)), 7)));
show("plain", plain);

// The left operand converts after the right operand runs a setter.
const a = new Date(Date.UTC(2026, 0, 1));
const b = new Date(Date.UTC(2026, 0, 2));
console.log(a < (a.setUTCDate(3), b), a > b);
const c = new Date(Date.UTC(2026, 0, 1));
console.log(c >= (c.setTime(0), new Date(1)), c <= new Date(1));
const s = new Date(Date.UTC(2026, 0, 1));
console.log(s + (s.setUTCFullYear(1999), "!"));
const n = new Date(Date.UTC(2026, 0, 1));
console.log(+n === (n.setTime(5), 5), +n);

// Locals a function keeps as their time value: a method reads the time
// value after its arguments run a setter.
function locals(): void {
  const json = new Date(Date.UTC(2026, 0, 1));
  console.log(json.toJSON(json.setUTCFullYear(1999)), json.toJSON());
  const key = new Date(Date.UTC(2026, 0, 1));
  console.log(key.toJSON(String(key.setTime(Date.UTC(2021, 5, 1)))));
  const read = new Date(Date.UTC(2026, 0, 1));
  console.log(read.toJSON(), read.getTime());
}
locals();
