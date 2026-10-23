// A stateful singleton: a module-level log and an exported counter.
export let count = 0;
const log = [];
export const config = { mode: "default", owner: "state" };

export function record(entry) {
  log.push(entry);
  count++;
  return count;
}

export function entries() {
  return log.join(",");
}

export function reset() {
  log.length = 0;
  count = 0;
}
