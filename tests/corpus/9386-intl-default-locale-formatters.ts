// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// Formatters at the default locale (no locales argument, or undefined) and
// in the host time zone. The corpus pins both; the ICU data sweep
// (icu-data-filter.test.ts) runs this program under 47 locales and 3 time
// zones against Node, which is where the locale's numbering system, hour
// cycle, calendar and patterns are checked.
const VALUES: number[] = [0, -0, 1, -1, 0.5, 1.005, 1234.5678, -1234567.891, 0.000123, 1e21, 123456789012345680000, NaN, Infinity, -Infinity, 0.045, 99.995, 1e-7, 5, 1500, 999999, 1000000, 1.5e9, 0.1 + 0.2, 12, 0.999, 2.5, 3.5, -2.5, 1e6, 0.00001234];
function row(label: string, f: Intl.NumberFormat): void {
  console.log(label + ": " + VALUES.map((v) => f.format(v)).join(" | "));
}
function attempt(label: string, make: () => string): void {
  try {
    console.log(label + " => " + make());
  } catch (e) {
    const err = e as Error;
    console.log(label + " !! " + err.name + ": " + err.message);
  }
}

function numbers(): void {
  row("default", new Intl.NumberFormat());
  row("undefined", new Intl.NumberFormat(undefined));
  row("undefined percent", new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }));
  row("undefined EUR", new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }));
  row("undefined compact", new Intl.NumberFormat(undefined, { notation: "compact", compactDisplay: "long" }));
  row("undefined unit", new Intl.NumberFormat(undefined, { style: "unit", unit: "kilometer-per-hour", unitDisplay: "long" }));
  console.log((1234567.891).toLocaleString(undefined, { minimumFractionDigits: 2 }), new Intl.NumberFormat().format(0.5));
}

function dates(): void {
  const WHEN = [Date.UTC(2024, 1, 29, 13, 5, 9, 123), Date.UTC(2024, 6, 4, 3, 30, 0), 0];
  for (const ms of WHEN) {
    const d = new Date(ms);
    console.log(new Intl.DateTimeFormat().format(d), "|", new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d), "|", new Intl.DateTimeFormat("en-US", { dateStyle: undefined, weekday: "short", hour: "numeric" }).format(d));
    console.log(d.toLocaleString(), "|", d.toLocaleDateString(), "|", d.toLocaleTimeString(), "|", d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), "|", d.toLocaleTimeString(undefined, { timeZoneName: "long" }));
    console.log(d.toLocaleString("en-US"), "|", d.toLocaleDateString("en-US"), "|", d.toLocaleTimeString("en-US"), "|", d.toLocaleString(undefined, { timeZone: "Asia/Tokyo" }), "|", d.toLocaleString("en-US", { hour12: false }));
  }
}

numbers();
dates();
