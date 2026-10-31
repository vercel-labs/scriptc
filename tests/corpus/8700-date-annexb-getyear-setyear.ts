// Date.prototype's Annex B accessors: getYear() is the local full year less
// 1900 (NaN for an invalid date), and setYear(y) replaces the local year
// after mapping 0-99 to 1900+y, keeping the other local fields and starting
// an invalid date at January 1 of the epoch year. The year argument converts
// before the time value is read, so an argument that mutates the date changes
// the fields the setter keeps (V8's order, verified against Node). Node-exact
// for every case here (the printed fields are local, so the output does not
// depend on the host zone).
function fields(d: Date): string {
  const time = d.getTime();
  if (Number.isNaN(time)) return "invalid";
  return [
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ].join("/");
}

function yearOf(year: number): string {
  const d = new Date(2020, 2, 5, 10, 30, 15, 250);
  const returned = d.setYear(year);
  return `${year} -> ${fields(d)} returned-same=${Object.is(returned, d.getTime())}`;
}

console.log("getYear valid:", new Date(2020, 0, 1).getYear());
console.log("getYear 1999:", new Date(1999, 11, 31, 23, 59, 59).getYear());
console.log("getYear invalid:", new Date(Number.NaN).getYear());
console.log("getYear epoch:", new Date(1970, 0, 1).getYear());
for (const year of [0, 1, 42, 99, 100, 1900, 12.7, 99.9, 100.9, -1, -1.5, 275760, 275761]) {
  console.log("setYear", yearOf(year));
}
console.log("setYear NaN:", yearOf(Number.NaN));
console.log("setYear Infinity:", yearOf(Number.POSITIVE_INFINITY));

const invalid = new Date(Number.NaN);
invalid.setYear(2020);
console.log("setYear on invalid:", fields(invalid));
const invalidRelative = new Date(Number.NaN);
invalidRelative.setYear(5);
console.log("setYear relative on invalid:", fields(invalidRelative));

// getYear through a Date typed as a Date but held in an untyped slot
// (Date.prototype reading is a separate surface).
const held: Date = new Date(1987, 6, 4);
console.log("getYear held:", held.getYear(), held.getYear() + 1900 === held.getFullYear());
