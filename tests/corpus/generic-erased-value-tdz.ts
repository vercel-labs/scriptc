// A comparison of two const bindings that both trace to one generic
// declaration answers equal, as it does in JavaScript, but the operands are
// still read before the answer: a binding read before its initialization
// throws the temporal-dead-zone ReferenceError. A call through such a
// binding reads it the same way, so it throws before the arguments run.
// A `var` alias is hoisted as `undefined` instead: an early call evaluates
// its arguments and then throws "is not a function".
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

function callVarStored(): number {
  return varStored(5);
}
function varArgument(): number {
  console.log("var argument runs");
  return 5;
}
function callVarStoredWithArgument(): number {
  return varStored(varArgument());
}
try {
  console.log("early var call", callVarStored());
} catch (error) {
  console.log("caught var call", error instanceof TypeError, (error as Error).message);
}
try {
  console.log("early var call with argument", callVarStoredWithArgument());
} catch (error) {
  console.log("caught var argument call", error instanceof TypeError, (error as Error).message);
}
var varStored = identity;
console.log("late var", varStored(6), (varStored as any) === (stored as any));
