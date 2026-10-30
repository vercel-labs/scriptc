// Typed records updated through untyped views: a stats record written by a
// generic counter helper that takes `unknown`, settings merged with
// Object.assign, and typed reads in between. Each write stores into the
// native record; typed code reads the same object.
type Stats = { hits: number; misses: number; bytes: number; name: string; ok: boolean };
type Settings = { host: string; port: number; debug: boolean; retries: number };

const scale = Number(process.argv[2] ?? "1");

function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}

const stats: Stats[] = [];
for (let i = 0; i < 16; i++) stats.push({ hits: 0, misses: 0, bytes: 0, name: "s" + i, ok: true });

let seed = 12345;
let checksum = 0;
const rounds = Math.floor(1_000_000 * scale);
for (let i = 0; i < rounds; i++) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  const s = stats[seed & 15]!;
  if ((seed >>> 8) % 5 === 0) bump(s, "misses", 1);
  else bump(s, "hits", 1);
  bump(s, "bytes", (seed >>> 12) & 1023);
  checksum += s.hits - s.misses;
}

const settings: Settings = { host: "localhost", port: 80, debug: false, retries: 0 };
const view: object = settings;
const patches: object[] = [
  { port: 8080 },
  { debug: true, retries: 3 },
  { host: "example.test" },
  { port: 443, debug: false },
];
for (let i = 0; i < Math.floor(200_000 * scale); i++) {
  Object.assign(view, patches[i & 3]!);
  checksum += settings.port + settings.retries;
}

let hits = 0;
let bytes = 0;
for (const s of stats) {
  hits += s.hits;
  bytes += s.bytes;
}
console.log("hits", hits, "bytes", bytes, "settings", JSON.stringify(settings), "checksum", checksum);
