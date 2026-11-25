// A typed function with a rest parameter that reads `arguments.length`
// counts the arguments its caller passes, also when it is read as a value
// and called through that value: the value carries the same hidden
// actual-argument list, which every indirect call fills. The rest array
// only holds the arguments after the named positions.
function rest(...values: string[]): string {
  return `${arguments.length}:${values.join("-")}`;
}

function head(head: string, ...values: string[]): string {
  return `${arguments.length}:${head}:${values.join("-")}`;
}

function pair(...args: [number, string]): string {
  return `${arguments.length}:${args[0]}:${args[1]}`;
}

const heldRest = rest;
const heldHead = head;
const heldPair = pair;
console.log(heldRest(), heldRest("a"), heldRest("a", "b"));
console.log(heldHead("h"), heldHead("h", "a", "b"));
console.log(heldPair(1, "a"));

const many = ["a", "b", "c"];
console.log(heldRest(...many), heldHead("h", ...many));
console.log(heldRest(...[]));

// A value held in an ordinary binding inside a function answers the same
// way, and the value keeps the declaration's length and name.
function inside(): string {
  const local = head;
  return `${local("x")}|${local("x", "y", "z")}|${local("w", ...many)}`;
}
console.log(inside());
console.log(heldRest.length, heldHead.length, heldRest.name, heldHead.name);

// The same value handed to an untyped slot keeps every argument too.
function boxed(fn: unknown): string {
  return String((fn as (...values: string[]) => string)("b", "c"));
}
console.log(boxed(rest));

// A value passed where a callback receives its own arguments: the count is
// the call's, not the declared parameter list's.
const counts = [many, []].map((values) => heldHead("call", ...values));
console.log(counts.join(","));
