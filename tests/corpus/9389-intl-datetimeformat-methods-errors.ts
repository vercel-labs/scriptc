// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// The required and default components of Intl.DateTimeFormat,
// toLocaleString, toLocaleDateString and toLocaleTimeString; what format()
// takes (a Date, a number, nothing) and its RangeError; an invalid Date,
// which answers "Invalid Date" before any option is read; a Date changed by
// an argument, which is formatted as changed; and the constructor's errors
// with V8's texts.

function defaultsAndMethods(): void {
  const d = new Date(Date.UTC(2024, 1, 29, 13, 5, 9, 123));
  const utc = { timeZone: "UTC" } as const;
  console.log(new Intl.DateTimeFormat("en-US", utc).format(d), "|", new Intl.DateTimeFormat("en", utc).format(d), "|", Intl.DateTimeFormat("en-US", utc).format(d));
  console.log(d.toLocaleString("en-US", utc), "|", d.toLocaleDateString("en-US", utc), "|", d.toLocaleTimeString("en-US", utc));
  console.log(d.toLocaleDateString("en-US", { ...utc, hour: "numeric" }), "|", d.toLocaleDateString("en-US", { ...utc, weekday: "long" }), "|", d.toLocaleDateString("en-US", { ...utc, timeZoneName: "short" }), "|", d.toLocaleDateString("en-US", { ...utc, era: "short" }));
  console.log(d.toLocaleTimeString("en-US", { ...utc, year: "numeric" }), "|", d.toLocaleTimeString("en-US", { ...utc, minute: "2-digit" }), "|", d.toLocaleTimeString("en-US", { ...utc, timeZoneName: "short" }), "|", d.toLocaleTimeString("en-US", { ...utc, fractionalSecondDigits: 2 }));
  console.log(d.toLocaleString("en-US", { ...utc, month: "long" }), "|", d.toLocaleString("en-US", { ...utc, second: "numeric" }), "|", d.toLocaleString("en-US", { ...utc, timeZoneName: "long" }), "|", d.toLocaleString("en-US", { ...utc, dayPeriod: "long" }));
  console.log(new Intl.DateTimeFormat("en-US", { ...utc, hour: "numeric" }).format(d), "|", new Intl.DateTimeFormat("en-US", { ...utc, timeZoneName: "short" }).format(d), "|", new Intl.DateTimeFormat("en-US", { ...utc, era: "long" }).format(d), "|", new Intl.DateTimeFormat("en-US", { ...utc, dayPeriod: "short" }).format(d));
  const f = new Intl.DateTimeFormat("en-US", { ...utc, dateStyle: undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  console.log(f.format(d), f.format(0), f.format(d.getTime()), f.format(1.9), f.format(-1.9), f.format(8.64e15), f.format(-8.64e15));
  console.log(typeof f.format(), typeof new Intl.DateTimeFormat("en-US").format(undefined), f.format(new Date(0)));
  const longDay: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", timeZone: "UTC" };
  longDay.day = "2-digit";
  console.log(d.toLocaleDateString("en-US", longDay), "|", d.toLocaleString(undefined, longDay));
  const invalid = new Date(NaN);
  console.log(invalid.toLocaleString("en-US", utc), invalid.toLocaleDateString("en-US", { year: "x" as "numeric" }), invalid.toLocaleTimeString("en-US", null as unknown as Intl.DateTimeFormatOptions), invalid.toLocaleDateString());
  let ms = Date.UTC(2020, 0, 1);
  const moving = new Date(ms);
  console.log(moving.toLocaleDateString("en-US", { timeZone: (moving.setTime(0), "UTC") }), moving.getTime());
  const formatters: Intl.DateTimeFormat[] = [f, new Intl.DateTimeFormat("en-US", { ...utc, month: "long" })];
  console.log(formatters.map((each) => each.format(d)).join(" | "), formatters[0] === f);
  function stamp(when: Date, formatter: Intl.DateTimeFormat = f): string {
    return formatter.format(when);
  }
  console.log(stamp(d), stamp(new Date(ms), formatters[1]));
}

function errors(): void {
  function attemptDate(label: string, make: () => string): void {
    try {
      console.log(label + " => " + make());
    } catch (e) {
      const err = e as Error;
      console.log(label + " !! " + err.name + ": " + err.message);
    }
  }
  function dtf(options: unknown): string {
    return new Intl.DateTimeFormat("en-US", options as Intl.DateTimeFormatOptions).format(0);
  }
  const epoch = new Date(0);
  attemptDate("year bad", () => dtf({ year: "x" }));
  attemptDate("month number", () => dtf({ month: 2 }));
  attemptDate("weekday bad", () => dtf({ weekday: "numeric" }));
  attemptDate("hour bad", () => dtf({ hour: "short" }));
  attemptDate("fsd 0", () => dtf({ fractionalSecondDigits: 0 }));
  attemptDate("fsd 4", () => dtf({ fractionalSecondDigits: 4 }));
  attemptDate("fsd string", () => dtf({ timeZone: "UTC", second: "numeric", fractionalSecondDigits: "2" }));
  attemptDate("fsd 2.9", () => dtf({ timeZone: "UTC", second: "numeric", fractionalSecondDigits: 2.9 }));
  attemptDate("fsd NaN", () => dtf({ fractionalSecondDigits: NaN }));
  attemptDate("hourCycle bad", () => dtf({ hourCycle: "h25" }));
  attemptDate("hour12 string", () => dtf({ timeZone: "UTC", hour: "numeric", hour12: "false" }));
  attemptDate("hour12 0", () => dtf({ timeZone: "UTC", hour: "numeric", hour12: 0 }));
  attemptDate("hour12 null", () => dtf({ timeZone: "UTC", hour: "numeric", hour12: null }));
  attemptDate("timeZoneName bad", () => dtf({ timeZoneName: "x" }));
  attemptDate("formatMatcher bad", () => dtf({ formatMatcher: "x" }));
  attemptDate("formatMatcher basic", () => dtf({ timeZone: "UTC", formatMatcher: "basic" }));
  attemptDate("localeMatcher bad", () => dtf({ localeMatcher: "x" }));
  attemptDate("calendar bad", () => dtf({ calendar: "x" }));
  attemptDate("numberingSystem bad", () => dtf({ numberingSystem: "x" }));
  attemptDate("dateStyle bad", () => dtf({ dateStyle: "x" }));
  attemptDate("timeStyle bad", () => dtf({ timeStyle: "x" }));
  attemptDate("dateStyle and year", () => dtf({ dateStyle: "short", year: "numeric" }));
  attemptDate("timeStyle and hour", () => dtf({ timeStyle: "short", hour: "numeric" }));
  attemptDate("dateStyle and fsd", () => dtf({ dateStyle: "short", fractionalSecondDigits: 1 }));
  attemptDate("toLocaleDateString timeStyle", () => epoch.toLocaleDateString("en-US", { timeStyle: "short" }));
  attemptDate("toLocaleTimeString dateStyle", () => epoch.toLocaleTimeString("en-US", { dateStyle: "short" }));
  attemptDate("zone bad", () => dtf({ timeZone: "Mars/Olympus" }));
  attemptDate("zone before year", () => dtf({ timeZone: "Mars/Olympus", year: "x" }));
  attemptDate("hourCycle before zone", () => dtf({ timeZone: "Mars/Olympus", hourCycle: "x" }));
  attemptDate("options null", () => dtf(null));
  attemptDate("options number", () => dtf(5));
  attemptDate("toLocaleString null", () => epoch.toLocaleString("en-US", null as unknown as Intl.DateTimeFormatOptions));
  attemptDate("toLocaleDateString null", () => epoch.toLocaleDateString("en-US", null as unknown as Intl.DateTimeFormatOptions));
  attemptDate("toLocaleTimeString null", () => epoch.toLocaleTimeString("en-US", null as unknown as Intl.DateTimeFormatOptions));
  attemptDate("toLocaleDateString year bad", () => epoch.toLocaleDateString("en-US", { year: "x" as "numeric" }));
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
  attemptDate("format NaN", () => f.format(NaN));
  attemptDate("format invalid date", () => f.format(new Date(NaN)));
  attemptDate("format out of range", () => f.format(8.64e15 + 1));
  attemptDate("format infinity", () => f.format(-Infinity));
  attemptDate("format edge", () => f.format(8.64e15));
}

defaultsAndMethods();
errors();
