// Date.prototype.toUTCString: "Www, DD Mmm YYYY HH:mm:ss GMT" in UTC, a
// leading "-" and at least four digits for negative years, "Invalid Date"
// for an invalid time value.
const times = [
  0,
  -1,
  1445412480000,
  951782400000, // 2000-02-29
  Date.UTC(1969, 11, 31, 23, 59, 59, 999),
  Date.UTC(0, 0, 1) - 1900 * 365.2425 * 86400000,
  Date.UTC(-1, 5, 15, 12, 30, 45),
  Date.UTC(-271821, 3, 20),
  8.64e15,
  -8.64e15,
  1234.9,
  -1234.9,
  NaN,
  8.64e15 + 1,
];
for (const t of times) {
  const d = new Date(t);
  console.log(d.toUTCString());
}
for (let day = 0; day < 7; day++) console.log(new Date(Date.UTC(2024, 0, day + 1)).toUTCString());
for (let month = 0; month < 12; month++) console.log(new Date(Date.UTC(2023, month, 9, 8, 7, 6)).toUTCString());
console.log(new Date("2015-10-21T07:28:00Z").toUTCString(), new Date("garbage").toUTCString());
