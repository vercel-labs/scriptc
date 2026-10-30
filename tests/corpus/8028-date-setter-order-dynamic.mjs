// Date setters reached through untyped values: without arguments each
// one makes the Date invalid, and an argument that calls setTime on the
// same Date is seen by the setter.
process.env.TZ = "UTC";

const names = [
  "setMilliseconds", "setSeconds", "setMinutes", "setHours", "setDate", "setMonth", "setFullYear",
  "setUTCMilliseconds", "setUTCSeconds", "setUTCMinutes", "setUTCHours", "setUTCDate", "setUTCMonth", "setUTCFullYear",
];
for (const name of names) {
  const d = new Date(Date.UTC(2026, 5, 15));
  console.log(name, d[name](), d.getTime());
}
const d = new Date(Date.UTC(2026, 3, 10, 12));
console.log(d.setUTCHours((d.setTime(Date.UTC(2000, 0, 1)), 5)), d.toISOString());
const a = new Date(Date.UTC(2026, 0, 1));
console.log(a < (a.setUTCDate(3), new Date(Date.UTC(2026, 0, 2))));
