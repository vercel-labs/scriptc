// @requires-icu
// @env: TZ=UTC,LC_ALL=de_DE.UTF-8
// Date.prototype.toLocaleString() and toLocaleTimeString() with no
// arguments: the DEFAULT locale's date-time and time patterns, in the host
// time zone (scr_intl.c asks ICU for the best pattern of the skeleton V8
// asks for, "yMdjms" and "jms", and applies V8's U+202F → U+0020 revert).
// The corpus pins TZ and LC_ALL so the two sides read the same zone and
// locale; everything below — field order, separators, the 24-hour cycle
// this locale prefers, and the Invalid Date text — compares byte for byte.
const dates = [
  new Date(0),
  new Date(1700000000000),
  new Date(1234567890123),
  new Date(2024, 1, 29, 0, 0, 0),
  new Date(1999, 11, 31, 23, 59, 59, 999),
];
for (const d of dates) console.log(d.toLocaleString(), "|", d.toLocaleTimeString());

// The morning/afternoon boundary and the yMdjms pattern's own separators.
console.log(new Date(2023, 10, 14, 9, 5, 7).toLocaleString());
console.log(new Date(2023, 10, 14, 13, 5, 7).toLocaleString());
console.log(new Date(2023, 10, 14, 13, 5, 7).toLocaleTimeString());

// An invalid date answers "Invalid Date" on both methods.
const invalid = new Date(NaN);
console.log(invalid.toLocaleString(), "|", invalid.toLocaleTimeString());

// The results are ordinary strings.
const label = `Zeit: ${new Date(1700000000000).toLocaleTimeString()}`;
console.log(label, label.length, new Date(0).toLocaleString().length);

// Dates before the Gregorian reform keep their proleptic Gregorian fields, as
// in ECMAScript time: 1582-10-04, the year 1000, the year 1, and the earliest
// time value.
const early = [Date.UTC(1582, 9, 4, 12), Date.UTC(1582, 9, 15), Date.UTC(1000, 0, 1), -8.64e15];
const yearOne = new Date(0);
yearOne.setUTCFullYear(1, 0, 1);
for (const ms of [...early, yearOne.getTime()]) {
  const d = new Date(ms);
  console.log(d.toLocaleString(), "|", d.toLocaleTimeString());
}
