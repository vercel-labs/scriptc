// Iterator helper objects in JavaScript: inferred callback parameters,
// return() on a helper (before its first next(), mid-way and after
// completion), and chains over Map/Set iterators.
const log = [];
function* count(label, n) {
  try {
    for (let i = 1; i <= n; i++) {
      log.push(label + i);
      yield i;
    }
  } finally {
    log.push(label + ":closed");
  }
}
function flush(what) {
  console.log(what, "|", log.join(" "));
  log.length = 0;
}

flush(count("a", 4).map((x) => x + 0.5).toArray());
flush(count("b", 6).filter((x) => x % 2 === 1).map((x, i) => x * 10 + i).take(2).toArray());
flush(count("c", 3).reduce((acc, x) => acc + x, ""));

// return() before the first next() closes a source that has started.
const started = count("d", 3);
started.next();
const mapped = started.map((x) => x * 2);
flush([mapped.return(), started.next()]);
// ... and leaves an unstarted source without running its body.
const fresh = count("e", 3);
const filtered = fresh.filter(() => true);
flush([filtered.return(), fresh.next(), filtered.next()]);
// return() at a yield closes the source; later calls report done.
const stepping = count("f", 5).take(4);
flush([stepping.next(), stepping.return(), stepping.next(), stepping.return()]);
// A chain of helpers closes through to the source.
const chained = count("g", 5);
chained.next();
const chain = chained.map((x) => x).filter(() => true).take(3);
flush([chain.return(), chained.next()]);

// Map and Set iterators.
const scores = new Map([
  ["ann", 3],
  ["bob", 9],
  ["cy", 5],
]);
console.log(scores.entries().filter(([, v]) => v > 4).map(([k]) => k).toArray());
console.log(scores.values().every((v) => v > 2), scores.keys().find((k) => k.length === 2));
const tags = new Set(["x", "y", "z"]);
const upper = tags.values().map((t) => t.toUpperCase());
tags.add("w");
console.log([...upper], tags.keys().drop(3).toArray());
for (const t of tags.values().flatMap((t) => [t, t + t])) {
  if (t === "yy") break;
  log.push(t);
}
flush("flat");
