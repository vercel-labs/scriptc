// Date setters: every local and UTC setter with each argument count, the
// time values they return, normalization of out-of-range fields, local
// setters across a daylight saving transition, setters on invalid dates,
// explicit undefined arguments, fractional arguments, and the TimeClip
// range. A setter changes the one Date object every alias holds.
export {};
process.env.TZ = "America/Chicago";

const show = (label: string, d: Date): void => {
  console.log(label, d.getTime(), Number.isNaN(d.getTime()) ? "invalid" : d.toISOString());
};

const d = new Date(Date.UTC(2026, 0, 31, 10, 20, 30, 400));
console.log(d.setMilliseconds(999), d.getMilliseconds());
console.log(d.setSeconds(5), d.setSeconds(6, 7));
console.log(d.setMinutes(1), d.setMinutes(2, 3), d.setMinutes(4, 5, 6));
console.log(d.setHours(7), d.setHours(8, 9), d.setHours(10, 11, 12), d.setHours(13, 14, 15, 16));
console.log(d.setDate(15), d.setMonth(1), d.setMonth(2, 3));
console.log(d.setFullYear(2025), d.setFullYear(2024, 1), d.setFullYear(2023, 4, 6));
show("local", d);

const u = new Date(Date.UTC(2026, 0, 31));
console.log(u.setUTCMilliseconds(1), u.setUTCSeconds(2, 3), u.setUTCMinutes(4, 5, 6));
console.log(u.setUTCHours(7, 8, 9, 10), u.setUTCDate(1), u.setUTCMonth(5, 30));
console.log(u.setUTCFullYear(1999), u.setUTCFullYear(2000, 1, 29));
show("utc", u);

// Fields out of range carry into the next larger field, both ways.
const n = new Date(Date.UTC(2026, 0, 31, 12));
n.setUTCMonth(1);
show("Jan 31 + month", n);
n.setUTCDate(0);
show("day 0", n);
n.setUTCMonth(13);
show("month 13", n);
n.setUTCHours(-1);
show("hour -1", n);
n.setUTCMinutes(60 * 24 + 1);
show("minutes past a day", n);
n.setUTCSeconds(-0.5);
show("fractional seconds", n);
n.setUTCMilliseconds(1.9);
show("fractional ms", n);

// Local setters in a zone with daylight saving time: 2026-03-08 02:30
// does not exist in Chicago and 2026-11-01 01:30 happens twice.
const spring = new Date(2026, 2, 8, 0, 0);
spring.setHours(2, 30);
show("spring gap", spring);
console.log(spring.getHours(), spring.getMinutes(), spring.getTimezoneOffset());
const fall = new Date(2026, 10, 1, 0, 0);
fall.setHours(1, 30);
show("fall overlap", fall);
fall.setMinutes(fall.getMinutes() + 60);
show("fall overlap + 60 min", fall);
const walk = new Date(2026, 2, 7, 12);
for (let i = 0; i < 3; i++) {
  walk.setDate(walk.getDate() + 1);
  console.log("walk", walk.getDate(), walk.getHours(), walk.getTimezoneOffset());
}

// Invalid dates: setFullYear starts from +0 local time, the others keep NaN.
const bad = new Date(NaN);
console.log(bad.setHours(1), bad.setDate(2), bad.setUTCMonth(3), bad.setMilliseconds(4));
console.log(bad.setFullYear(2020));
show("after setFullYear", bad);
const badUtc = new Date("not a date");
console.log(badUtc.setUTCFullYear(2021, 6));
show("after setUTCFullYear", badUtc);

// Explicit undefined and NaN arguments make the date invalid; a missing
// optional argument keeps the current field.
const opt = new Date(Date.UTC(2026, 5, 15, 9));
console.log(opt.setUTCHours(10, undefined), Number.isNaN(opt.getTime()));
const opt2 = new Date(Date.UTC(2026, 5, 15, 9));
console.log(opt2.setUTCMonth(Number.NaN), opt2.setUTCMonth(2));

// setTime and the TimeClip range.
const t = new Date(0);
console.log(t.setTime(8.64e15), t.setTime(8.64e15 + 1), t.setTime(-8.64e15), t.setTime(1.5));
console.log(t.setTime(-0), Object.is(t.getTime(), 0), t.setTime(Number.NaN));
const far = new Date(Date.UTC(275760, 8, 13));
console.log(far.getTime(), far.setUTCMilliseconds(1));

// Every alias sees the change: a second binding, an array slot, a Map
// value, a record field, a closure and a parameter.
const shared = new Date(Date.UTC(2026, 6, 4));
const alias = shared;
const list = [shared, new Date(Date.UTC(2000, 0, 1))];
const byName = new Map<string, Date>([["shared", shared]]);
const holder = { when: shared };
const bump = (): number => shared.setUTCDate(shared.getUTCDate() + 1);
const nextYear = (date: Date): void => {
  date.setUTCFullYear(date.getUTCFullYear() + 1);
};
alias.setUTCHours(6);
list[0]!.setUTCMinutes(30);
byName.get("shared")!.setUTCSeconds(15);
holder.when.setUTCMilliseconds(250);
bump();
nextYear(shared);
show("shared", shared);
console.log(alias === shared, list[0] === shared, byName.get("shared") === holder.when);
console.log(list.map((x) => x.toISOString()).join(" "));

// A Date a loop adjusts in place.
const cursor = new Date(Date.UTC(2026, 0, 1));
let weekdays = 0;
while (cursor.getUTCFullYear() === 2026) {
  const day = cursor.getUTCDay();
  if (day !== 0 && day !== 6) weekdays++;
  cursor.setUTCDate(cursor.getUTCDate() + 1);
}
console.log("weekdays in 2026", weekdays);
show("cursor", cursor);
