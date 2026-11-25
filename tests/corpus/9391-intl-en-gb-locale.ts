// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// The en-GB formatter locale: Node's lookup keeps the tag as it is (no
// shorter tag shadows it), and ECMA-402 gives it British number and date
// patterns. The lowering used to refuse it by name; the runtime already
// builds the formatter from the tag, so the compiled output must match
// Node byte for byte: spaces for grouping (not commas), the GBP symbol
// after the number, and day-first dates.
const x = 1234567.891;
console.log(x.toLocaleString("en-GB"));
console.log(x.toLocaleString("en-GB", { minimumFractionDigits: 2 }));
console.log(new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(1234.5));
console.log(new Intl.NumberFormat("en-GB", { notation: "compact" }).format(1250000));

const when = new Date(Date.UTC(2026, 10, 20, 11, 30));
console.log(when.toLocaleDateString("en-GB"));
console.log(when.toLocaleTimeString("en-GB"));
console.log(new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(when));
console.log(new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(when));
