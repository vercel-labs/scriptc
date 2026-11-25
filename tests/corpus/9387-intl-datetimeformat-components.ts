// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// Intl.DateTimeFormat objects over ICU: every component with each of its
// values, alone and combined, and the hour cycles: an hourCycle or hour12
// option applies to an hour the options ask for, and a default hour takes
// the 12-hour or 24-hour form of the cycle.

function components(): void {
  const WHEN = [Date.UTC(2024, 1, 29, 13, 5, 9, 123), Date.UTC(1999, 11, 31, 23, 59, 59, 999), Date.UTC(2026, 6, 4, 0, 30, 0, 7), -1e14];
  function line(label: string, options: Intl.DateTimeFormatOptions): void {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
    console.log(label + ": " + WHEN.map((ms) => f.format(ms)).join(" | "));
  }
  for (const weekday of ["narrow", "short", "long"] as const) line("weekday " + weekday, { weekday });
  for (const era of ["narrow", "short", "long"] as const) line("era " + era, { era, year: "numeric" });
  for (const year of ["2-digit", "numeric"] as const) line("year " + year, { year });
  for (const month of ["2-digit", "numeric", "narrow", "short", "long"] as const) {
    line("month " + month, { month });
    line("month " + month + " day year", { month, day: "numeric", year: "numeric" });
    line("month " + month + " weekday", { month, weekday: "long", day: "2-digit" });
  }
  for (const day of ["2-digit", "numeric"] as const) line("day " + day, { day });
  for (const hour of ["2-digit", "numeric"] as const) {
    line("hour " + hour, { hour });
    for (const minute of ["2-digit", "numeric"] as const) {
      line("hour " + hour + " minute " + minute, { hour, minute });
      for (const second of ["2-digit", "numeric"] as const) line("hms " + hour + " " + minute + " " + second, { hour, minute, second });
    }
  }
  line("minute", { minute: "numeric" });
  line("minute 2", { minute: "2-digit" });
  line("second", { second: "numeric" });
  line("minute second", { minute: "2-digit", second: "2-digit" });
  for (const fractionalSecondDigits of [1, 2, 3] as const) {
    line("fraction " + fractionalSecondDigits, { fractionalSecondDigits });
    line("second fraction " + fractionalSecondDigits, { second: "numeric", fractionalSecondDigits });
    line("hms fraction " + fractionalSecondDigits, { hour: "numeric", minute: "numeric", second: "numeric", fractionalSecondDigits });
  }
  for (const dayPeriod of ["narrow", "short", "long"] as const) {
    line("dayPeriod " + dayPeriod, { dayPeriod });
    line("dayPeriod " + dayPeriod + " hour", { dayPeriod, hour: "numeric" });
  }
  for (const timeZoneName of ["short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric"] as const) {
    line("zone " + timeZoneName, { timeZoneName });
    line("zone " + timeZoneName + " hm", { timeZoneName, hour: "numeric", minute: "2-digit" });
  }
  line("everything", { weekday: "long", era: "short", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, timeZoneName: "short" });
  line("empty", {});
}

function hourCycles(): void {
  const WHEN = [Date.UTC(2024, 1, 29, 0, 5, 9), Date.UTC(2024, 1, 29, 12, 0, 0), Date.UTC(2024, 1, 29, 13, 5, 9), Date.UTC(2024, 1, 29, 23, 59, 59)];
  function line(label: string, options: Intl.DateTimeFormatOptions): void {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
    console.log(label + ": " + WHEN.map((ms) => f.format(ms)).join(" | "));
  }
  for (const hourCycle of ["h11", "h12", "h23", "h24"] as const) {
    line(hourCycle + " numeric", { hourCycle, hour: "numeric" });
    line(hourCycle + " 2-digit", { hourCycle, hour: "2-digit" });
    line(hourCycle + " hm", { hourCycle, hour: "numeric", minute: "2-digit" });
    line(hourCycle + " hms", { hourCycle, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    line(hourCycle + " date", { hourCycle, month: "short", day: "numeric", hour: "numeric" });
    line(hourCycle + " no hour", { hourCycle, minute: "2-digit", second: "2-digit" });
    line(hourCycle + " dayPeriod", { hourCycle, hour: "numeric", dayPeriod: "short" });
    line(hourCycle + " hour12 true", { hourCycle, hour12: true, hour: "numeric", minute: "2-digit" });
    line(hourCycle + " hour12 false", { hourCycle, hour12: false, hour: "numeric", minute: "2-digit" });
  }
  line("hour12 true", { hour12: true, hour: "numeric", minute: "2-digit" });
  line("hour12 false", { hour12: false, hour: "numeric", minute: "2-digit" });
  line("hour12 false 2-digit", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  line("hour12 true no hour", { hour12: true, year: "numeric" });
  line("hour12 false defaults", { hour12: false });
  for (const ms of WHEN) {
    const d = new Date(ms);
    console.log(d.toLocaleTimeString("en-US", { hour12: false, timeZone: "UTC" }), "|", d.toLocaleTimeString("en-US", { hourCycle: "h24", timeZone: "UTC" }), "|", d.toLocaleString("en-US", { hour12: false, timeZone: "UTC" }), "|", d.toLocaleString("en-US", { hourCycle: "h11", timeZone: "UTC" }));
  }
}

components();
hourCycles();
