// A program module reached only through a BOUNDED import() — no static
// import edge names it. The program still compiles it, and the island
// loads the same native instance (tests/harness/node-island.test.ts).
export let hits = 0;
const log = [];

export function note(entry) {
  log.push(entry);
  hits++;
  return hits;
}

export function entries() {
  return log.join(",");
}
