// An empty object literal asserted to a record type starts with no
// properties, also when earlier objects built the same way were filled in
// and dropped: nothing of a dropped object shows up in a new one.
type Stats = { hits: number; misses: number; label: string };

function filled(n: number): Stats {
  const stats = {} as Stats;
  stats.label = "run " + n;
  stats.hits = n;
  stats.misses = n * 2;
  return stats;
}

let total = 0;
for (let i = 0; i < 64; i++) total += filled(i).hits;

const fresh = {} as Stats;
console.log(total, JSON.stringify(fresh), Object.keys(fresh).length, "hits" in fresh, "label" in fresh);
fresh.misses = 7;
console.log(JSON.stringify(fresh), Object.keys(fresh).join(","));

// Objects that write different keys in different orders, one after another.
function some(n: number): string {
  const stats = {} as Stats;
  if (n % 3 === 0) stats.hits = n;
  if (n % 3 === 1) {
    stats.misses = n;
    stats.label = "m";
  }
  if (n % 3 === 2) {
    stats.label = "l";
    stats.hits = n;
    stats.misses = n;
  }
  return Object.keys(stats).join(",") + ":" + JSON.stringify(stats);
}
for (let n = 0; n < 6; n++) console.log(some(n));

// A literal that writes one property, filled, dropped and made again.
function seeded(n: number): string {
  const stats = { label: "seed" } as Stats;
  if (n > 0) stats.hits = n;
  return JSON.stringify(stats);
}
console.log(seeded(1), seeded(0), seeded(2), seeded(0));
