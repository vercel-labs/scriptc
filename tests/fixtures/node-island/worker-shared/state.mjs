// A program module the island's plugin imports too: shared with the island
// (tests/harness/node-island.test.ts, "a module shared with the island").
const state = { count: 0 };
export function record() {
  state.count++;
  return state.count;
}
export function current() {
  return state.count;
}
