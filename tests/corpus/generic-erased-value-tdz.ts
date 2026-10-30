// A comparison of two const bindings that both trace to one generic
// declaration answers equal, as it does in JavaScript, but the operands are
// still read before the answer: a binding read before its initialization
// throws the temporal-dead-zone ReferenceError. A call through such a
// binding reads it the same way, so it throws before the arguments run.
function identity<T>(x: T): T {
  return x;
}
const pinned: (x: number) => number = identity;
function compare(): boolean {
  return (pinned as any) === (stored as any);
}
function callStored(): number {
  return stored(3);
}
try {
  console.log("early compare", compare());
} catch (error) {
  console.log("caught compare", error instanceof ReferenceError, (error as Error).message);
}
try {
  console.log("early call", callStored());
} catch (error) {
  console.log("caught call", error instanceof ReferenceError, (error as Error).message);
}
const stored = identity;
console.log("late", compare(), (pinned as any) !== (stored as any), stored(4));
