// Local-time getters read repeatedly on one Date and alternately on two,
// on Dates parsed from strings, and across process.env.TZ writes and
// deletes: every read answers the fields of the zone in effect at that
// moment, as in Node.

function fields(d: Date): string {
  return [
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getDay(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
    d.getTimezoneOffset(),
  ].join(",");
}

const a = new Date(Date.UTC(2024, 2, 10, 6, 59, 59, 999));
const b = new Date(Date.UTC(2024, 2, 10, 7, 0, 0, 0));
const c = new Date(Date.UTC(2024, 10, 3, 5, 30, 0, 250));

function report(label: string): void {
  console.log(label, fields(a), fields(a));
  console.log(label, fields(b), fields(c), fields(b));
  let mixed = 0;
  for (let i = 0; i < 6; i++) mixed += a.getHours() * 100 + b.getHours() + c.getDate();
  console.log(label, "alternating", mixed);
}

report("start");
process.env.TZ = "America/New_York";
report("new york");
process.env.TZ = "Asia/Kolkata";
report("kolkata");
process.env.TZ = "Australia/Lord_Howe";
report("lord howe");

// Dates parsed from strings with an explicit offset, read in local time.
const d = new Date("2024-06-01T23:45:00+05:30");
console.log("offset string", fields(d), d.getTime());
const e = new Date("2024-07-11T00:15:30.001Z");
console.log("offset string", fields(e), e.getTime());
console.log("first again", fields(d));

delete process.env.TZ;
report("deleted");
process.env.TZ = "UTC";
report("utc");

// Many instants read field by field.
process.env.TZ = "Europe/Berlin";
let sum = 0;
for (let i = 0; i < 2000; i++) {
  const t = new Date(1700000000000 + i * 3_599_999);
  sum += t.getHours() + t.getDate() * 3 + t.getMonth() * 7 + t.getTimezoneOffset();
}
console.log("berlin sum", sum);

const invalid = new Date(Number.NaN);
console.log("invalid", fields(invalid), fields(invalid));

// Instants around day and second boundaries, before the epoch and at the
// ends of the Date range, in UTC and local fields; then 2000-2030 in a zone
// with DST.
function utcFields(d: Date): string {
  return [
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCDay(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ].join(",");
}
const edges = [
  0, -0, -0.5, 0.5, -1, 1, -999, -1000, -1001, 999.9, -86_400_000, -86_400_001, 86_399_999,
  -62_198_755_200_000, -62_198_755_200_001, 8_640_000_000_000_000, -8_640_000_000_000_000,
  8_639_999_999_999_999, -8_639_999_999_999_999, 951_782_400_000, 4_107_542_399_999,
];
process.env.TZ = "UTC";
for (const t of edges) {
  const x = new Date(t);
  console.log(t, utcFields(x), fields(x));
}
process.env.TZ = "America/Sao_Paulo";
let walk = 0;
for (let t = 946_684_800_000; t < 1_893_456_000_000; t += 77_777_777) {
  const x = new Date(t);
  walk = (walk * 31 + x.getUTCDate() + x.getUTCHours() * 7 + x.getDate() + x.getMinutes() + x.getDay()) % 1_000_003;
}
console.log("walk", walk);
