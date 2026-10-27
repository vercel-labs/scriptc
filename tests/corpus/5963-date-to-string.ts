// Date.prototype.toString, toDateString and toTimeString, String(date),
// template literals and string concatenation print local time with the
// GMT offset and the zone's long name, as Node does. Each write to
// process.env.TZ changes the zone for later conversions and getters.
function at(ms: number): Date {
  return new Date(ms);
}
const winter = at(Date.UTC(2026, 0, 15, 12, 30, 45, 678));
const summer = at(Date.UTC(2026, 6, 15, 3, 4, 5));
const epoch = at(0);
const beforeEpoch = at(Date.UTC(1950, 5, 1, 18));
const farFuture = at(Date.UTC(2100, 6, 4, 9));
const yearZero = at(-62167219200000);
const maxDate = at(8.64e15);
const minDate = at(-8.64e15);
const invalid = new Date(NaN);

function show(zone: string): void {
  process.env.TZ = zone;
  console.log(`== ${zone}`);
  console.log(winter.toString());
  console.log(String(summer));
  console.log(`${epoch} | ${beforeEpoch}`);
  console.log("far: " + farFuture);
  console.log(winter.toDateString(), "/", winter.toTimeString());
  console.log(summer.toDateString(), "/", summer.toTimeString());
  console.log(summer.getHours(), summer.getTimezoneOffset());
}

for (const zone of [
  "America/Chicago",
  "America/New_York",
  "America/St_Johns",
  "Europe/Dublin",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Tokyo",
  "Australia/Lord_Howe",
  "Australia/Sydney",
  "Pacific/Chatham",
  "America/Sao_Paulo",
  "UTC",
  "Etc/GMT+5",
  "Etc/GMT-14",
  "US/Pacific",
  ":Asia/Seoul",
]) {
  show(zone);
}

// Daylight-time edges: the instants before and at a change.
process.env.TZ = "America/Chicago";
const spring = Date.UTC(2026, 2, 8, 8);
const autumn = Date.UTC(2026, 10, 1, 7);
console.log(new Date(spring - 1000).toString(), "|", new Date(spring).toString());
console.log(new Date(autumn - 1000).toTimeString(), "|", new Date(autumn).toTimeString());
process.env.TZ = "Europe/Dublin";
console.log(new Date(Date.UTC(2026, 2, 29, 0, 59, 59)).toString());
console.log(new Date(Date.UTC(2026, 2, 29, 1)).toString());
process.env.TZ = "Australia/Sydney";
console.log(new Date(Date.UTC(2026, 3, 4, 15, 59, 59)).toString());
console.log(new Date(Date.UTC(2026, 3, 4, 16)).toString());

// Extreme and invalid time values.
process.env.TZ = "UTC";
console.log(maxDate.toString(), "|", minDate.toDateString());
console.log(yearZero.toString(), "|", at(Date.UTC(-1, 11, 31, 23)).toDateString());
console.log(at(Date.UTC(-12345, 0, 1)).toDateString(), "|", at(Date.UTC(12345, 0, 1)).toDateString());
console.log(invalid.toString(), invalid.toDateString(), invalid.toTimeString(), `${invalid}`, String(invalid));

// A Date held as unknown converts the same way.
process.env.TZ = "Asia/Kolkata";
const held: unknown = winter;
console.log(String(held), `${held}`);

// Values that are not zone IDs and unset TZ.
for (const zone of ["Not/A_Zone", ""]) {
  process.env.TZ = zone;
  console.log(JSON.stringify(zone), winter.toString());
}
delete process.env.TZ;
process.env.TZ = "UTC";
console.log(winter.toString());

// Formatting functions and fields.
function stamp(label: string, d: Date): string {
  return `${label}: ${d.toDateString()} at ${d.toTimeString().slice(0, 8)}`;
}
const event = { name: "launch", when: summer };
process.env.TZ = "America/New_York";
console.log(stamp(event.name, event.when), "|", event.when.toString().length);
