// new Date(year, monthIndex, date, hours, minutes, seconds, ms) builds a
// LOCAL time: fields roll over through MakeDay/MakeTime, years 0-99 mean
// 1900-1999, and the result converts to UTC in the host zone. A time in a
// DST gap reads with the offset before the transition; a time in an
// overlap answers the earlier instant.
const zones = ["UTC", "America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Kolkata", "America/St_Johns", "Pacific/Apia"];
const years = [1800, 1969, 1970, 2000, 2024, 2038, 2100, 0, 49, 99, 100, -1, -271821, 275760];
for (const zone of zones) {
  process.env.TZ = zone;
  const out: string[] = [];
  for (const y of years) {
    for (const m of [0, 2, 9, 11, 12, -1]) {
      for (const d of [1, 31, 0]) out.push(`${y}/${m}/${d}=${new Date(y, m, d, 1, 30, 15, 500).getTime()}`);
    }
  }
  console.log(zone, out.join(" "));
  // Every quarter hour across a spring-forward and a fall-back day.
  const y = 2024;
  const m = zone === "America/New_York" || zone === "Europe/Berlin" ? 2 : 9;
  const d = zone === "America/New_York" ? 10 : zone === "Europe/Berlin" ? 31 : 6;
  const day: string[] = [];
  for (let minute = 0; minute < 24 * 60; minute += 15) {
    const spring = new Date(y, m, d, 0, minute);
    const fall = new Date(y, m + 7, d, 0, minute);
    day.push(`${spring.getTime()}:${spring.getHours()}:${fall.getTime()}:${fall.getMinutes()}`);
  }
  console.log(zone, day.join(" "));
  const date = new Date(2020, 0, 15, 12, 30, 45, 123);
  console.log(zone, date.getTime(), date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds(), date.getTimezoneOffset());
}
process.env.TZ = "America/New_York";
console.log(new Date(2020, 0).getTime(), new Date(2020, 0, 1, 0, 0, 0, 0.9).getTime(), new Date(2020.7, 0.9).getTime(), new Date(-0.5, 0).getTime());
console.log(new Date(1e6, 0).getTime(), new Date(1e6 + 0.5, 0).getTime(), new Date(2020, 1e7).getTime(), new Date(2020, 1e7 + 1).getTime());
console.log(new Date(NaN, 0).getTime(), new Date(2020, 0, Infinity).getTime(), new Date(2020, 0, 1, -Infinity).getTime());
console.log(new Date(275760, 8, 13).getTime(), new Date(275760, 8, 12, 20).getTime(), new Date(-271821, 3, 19, 20).getTime());
console.log(new Date(2021, 6, 4, 9, 5).toISOString(), new Date(99, 11, 31, 23, 59, 59, 999).toISOString());
