// A namespace with a binding that changes: the compiler keeps the live
// namespace object rather than a copy of its values.
export let counter = 1;
export function bump(): void {
  counter++;
}
