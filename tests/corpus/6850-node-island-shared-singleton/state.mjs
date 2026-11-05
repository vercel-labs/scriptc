// @ts-nocheck -- reassigning the exported function declaration below is the
// behavior under test; a checked file rejects the write.
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

// A function declaration whose binding this module reassigns: its export
// is live, like a `let` (a function declaration binds like `var`).
export function describe() {
  return "first";
}

export function retitle() {
  describe = () => "second";
}
