// Local-time fields of instants that walk across daylight-saving
// transitions: ascending and descending hourly sweeps longer than 19 days,
// minute steps around each transition, and instants in scattered order, in
// zones with 1-hour and 30-minute shifts and in both hemispheres. Every read
// answers the offset in effect at that instant, as in Node.

function fields(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()} ${d.getTimezoneOffset()}`;
}

function checksum(values: string[]): number {
  let h = 0;
  for (const v of values) for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return h;
}

const hour = 3600000;
const zones = ["America/New_York", "Europe/London", "Australia/Sydney", "Australia/Lord_Howe", "Asia/Kolkata"];
const starts = [Date.UTC(2024, 1, 20), Date.UTC(2024, 8, 15), Date.UTC(2023, 9, 1)];

for (const zone of zones) {
  process.env.TZ = zone;
  for (const start of starts) {
    const up: string[] = [];
    for (let t = start; t < start + 60 * 24 * hour; t += hour) up.push(fields(t));
    const down: string[] = [];
    for (let t = start + 60 * 24 * hour; t > start; t -= hour) down.push(fields(t));
    const offsets = new Set<number>();
    for (let t = start; t < start + 60 * 24 * hour; t += hour) offsets.add(new Date(t).getTimezoneOffset());
    console.log(zone, new Date(start).toISOString(), checksum(up), checksum(down), [...offsets].join("/"));
  }
  // Minute steps through each transition of 2024 and back.
  let previous = new Date(Date.UTC(2024, 0, 1)).getTimezoneOffset();
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2025, 0, 1); t += hour) {
    const offset = new Date(t).getTimezoneOffset();
    if (offset !== previous) {
      const near: string[] = [];
      for (let m = -90; m <= 90; m++) near.push(fields(t + m * 60000));
      for (let m = 90; m >= -90; m--) near.push(fields(t + m * 60000));
      console.log(zone, "transition", new Date(t).toISOString(), previous, offset, checksum(near));
      previous = offset;
    }
  }
  // Scattered instants: each lookup lands far from the last.
  const scattered: string[] = [];
  let x = 12345;
  for (let i = 0; i < 400; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    scattered.push(fields(Date.UTC(2020, 0, 1) + (x % 1800) * 24 * hour + (x % 24) * hour));
  }
  console.log(zone, "scattered", checksum(scattered));
}

// Tucumán changed its offset twice within 12 days in June 2004. Node's
// date cache takes an offset that matches 19 days apart as constant in
// between, so the answers between the two changes depend on the order of
// the reads. Seeded orders of reads around them, and across three years of
// zones with daylight-saving rules, each after a zone reset, answer as
// Node's do.
let seed = 987654;
const nextRandom = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function orderChecksum(zone: string, from: number, days: number, reads: number): number {
  process.env.TZ = "UTC";
  process.env.TZ = zone;
  let h = 0;
  for (let i = 0; i < reads; i++) {
    const d = new Date(from + Math.floor(nextRandom() * days * 24) * hour);
    h = (h * 31 + d.getTimezoneOffset() * 7 + d.getHours()) >>> 0;
  }
  return h;
}
const tucumanOrders: number[] = [];
for (let order = 0; order < 40; order++)
  tucumanOrders.push(orderChecksum("America/Argentina/Tucuman", Date.UTC(2004, 4, 1), 60, 25));
console.log("tucuman orders", tucumanOrders.join(","));
for (const zone of ["America/Argentina/Tucuman", "America/New_York", "Australia/Lord_Howe", "America/Sao_Paulo"]) {
  const sums: number[] = [];
  for (let order = 0; order < 10; order++) sums.push(orderChecksum(zone, Date.UTC(2003, 0, 1), 3 * 365, 60));
  console.log(zone, sums.join(","));
}

// Africa/Algiers kept its +1 offset on 21 October 1977 but left daylight
// time: the zone name changes while the offset does not, in every order of
// reads.
const algiers: number[] = [];
for (let day = 15; day <= 31; day++) algiers.push(Date.UTC(1977, 9, day, 12));
for (const order of ["ascending", "descending", "mixed"]) {
  process.env.TZ = "UTC";
  process.env.TZ = "Africa/Algiers";
  const reads =
    order === "ascending"
      ? algiers
      : order === "descending"
        ? algiers.slice().reverse()
        : [algiers[16]!, algiers[0]!, algiers[8]!, ...algiers];
  const names = new Map<number, string>();
  for (const t of reads) names.set(t, new Date(t).toString().slice(16));
  console.log(order, algiers.map((t) => names.get(t)).join(" | "));
}
