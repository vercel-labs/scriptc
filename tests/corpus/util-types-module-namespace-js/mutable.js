// A mutable export: the namespace keeps its live form, so a read answers
// the current value.
export let counter = 0;
export function bump() {
  counter += 1;
}
