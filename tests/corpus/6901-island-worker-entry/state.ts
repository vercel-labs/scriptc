// One module, two threads: the program compiles this copy for its own
// thread, and the worker's thread evaluates the island tree's copy, because
// Node gives every thread its own module instances.
export let count = 0;

export function bump(): number {
  count++;
  return count;
}
