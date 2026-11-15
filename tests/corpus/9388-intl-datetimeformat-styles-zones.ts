// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// dateStyle and timeStyle (alone, together, with an hour cycle that is not
// the pattern's own, and V8's TypeError beside a component), and the
// timeZone option: zone names in any letter case, the UTC names, links,
// offsets, and the RangeError of everything else.

function styles(): void {
  const WHEN = [Date.UTC(2024, 1, 29, 0, 5, 9), Date.UTC(2024, 1, 29, 13, 5, 9, 123), Date.UTC(1999, 11, 31, 23, 59, 59)];
  const STYLES = ["full", "long", "medium", "short"] as const;
  function line(label: string, options: Intl.DateTimeFormatOptions): void {
    try {
      const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...options });
      console.log(label + ": " + WHEN.map((ms) => f.format(ms)).join(" | "));
    } catch (e) {
      console.log(label + " !! " + (e as Error).name + ": " + (e as Error).message);
    }
  }
  for (const dateStyle of STYLES) {
    line("date " + dateStyle, { dateStyle });
    line("time " + dateStyle, { timeStyle: dateStyle });
    for (const timeStyle of STYLES) line(dateStyle + " + " + timeStyle, { dateStyle, timeStyle });
  }
  for (const hourCycle of ["h11", "h12", "h23", "h24"] as const) {
    for (const timeStyle of STYLES) {
      line(hourCycle + " time " + timeStyle, { hourCycle, timeStyle });
      line(hourCycle + " medium + " + timeStyle, { hourCycle, dateStyle: "medium", timeStyle });
    }
    line(hourCycle + " date only", { hourCycle, dateStyle: "long" });
  }
  for (const hour12 of [true, false]) {
    for (const timeStyle of STYLES) line("hour12 " + hour12 + " time " + timeStyle, { hour12, timeStyle });
    line("hour12 " + hour12 + " full + full", { hour12, dateStyle: "full", timeStyle: "full" });
  }
  line("style + weekday", { dateStyle: "short", weekday: "long" });
  line("style + zone name", { timeStyle: "short", timeZoneName: "short" });
  line("style + hour12 only", { dateStyle: "short", hour12: true });
  const d = new Date(WHEN[1]);
  console.log(d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }), "|", d.toLocaleDateString("en-US", { dateStyle: "full", timeZone: "UTC" }), "|", d.toLocaleTimeString("en-US", { timeStyle: "long", timeZone: "UTC" }));
  console.log(new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "medium", timeZone: "Asia/Tokyo" }).format(d));
}

function timeZones(): void {
  const d = new Date(Date.UTC(2024, 6, 4, 13, 5, 9));
  const winter = new Date(Date.UTC(2024, 0, 15, 22, 30, 0));
  for (const timeZone of ["UTC", "utc", "GMT", "Etc/UTC", "etc/gmt", "America/New_York", "america/new_york", "AMERICA/NEW_YORK", "Europe/Berlin", "Asia/Kolkata", "Asia/Calcutta", "Pacific/Chatham", "Australia/Lord_Howe", "America/Port-au-Prince", "aMeRiCa/pOrT-aU-pRiNcE", "US/Pacific", "Etc/GMT+5", "etc/gmt-14", "+05:30", "-0800", "+03", "-00:00", "+23:59", "Africa/Abidjan", "Antarctica/Troll", "America/Argentina/Buenos_Aires"]) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    const long = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", timeZoneName: "long" });
    console.log(timeZone + ": " + f.format(d) + " | " + f.format(winter) + " | " + long.format(d) + " | " + d.toLocaleString("en-US", { timeZone }));
  }
  for (const timeZone of ["Mars/Olympus", "", " UTC", "UTC ", "+24:00", "+05:60", "+5", "+05:30:00", "+0530x", "America", "New_York", "GMT+5", "UTC+1", "Z", "EST5", "Europe/Berlin/", "1", "null", "undefined", "Étc/UTC", "Asia/Kolkata\u0000"]) {
    try {
      console.log(JSON.stringify(timeZone), new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", timeZoneName: "short" }).format(d));
    } catch (e) {
      console.log(JSON.stringify(timeZone), (e as Error).name + ": " + (e as Error).message);
    }
  }
}

styles();
timeZones();
