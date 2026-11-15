// A `null`/`undefined` comparison the checker can decide statically still
// evaluates its operand: a call, an awaited import, a getter read and a
// sequence expression all run once, in place, and the comparison answers the
// literal the checker decided. (`f() !== null` on a `string`-returning call
// is true, but `f` still runs.)
const order: string[] = [];

function call(): string {
  order.push("call");
  return "x";
}
function maybe(): string | undefined {
  order.push("call-maybe");
  return undefined;
}

console.log(call() !== null, call() !== undefined, call() === null, call() === undefined);
console.log(call() != null, call() == null);
console.log(maybe() !== null, maybe() != null);

// Both operand positions: the unit literal may be on the left.
console.log(null !== call(), undefined === maybe());

// An awaited import in the decided position runs the import before the
// answer.
console.log((await import("node:os")) !== null);
order.push("after-import");

// A getter read in the decided position runs the getter.
class Holder {
  get value(): string {
    order.push("getter");
    return "v";
  }
}
const holder = new Holder();
console.log(holder.value !== null, holder.value === undefined);

// A sequence expression whose value is a unit still runs its left side, and
// the unit literal may sit on either side of the operator.
console.log((order.push("seq"), undefined) == null, (order.push("seq"), undefined) != null);
console.log((order.push("seq-null"), null) == null, null === (order.push("seq-left"), undefined));
let counter = 0;
console.log((counter++, undefined) == null, counter);

// A sequence whose VALUE is a call runs that call too: the decided answer
// replaces the comparison, not the operand's own result.
function seqFirst(): number {
  order.push("seq-first");
  return 1;
}
function seqLast(): number {
  order.push("seq-last");
  return 2;
}
console.log((seqFirst(), seqLast()) !== null, (seqFirst(), seqLast()) === undefined);
console.log((seqFirst(), seqLast()) == null ? "nullish" : "present");

// The expression's value flows on: the literal is what a conditional, a
// boolean coercion and a stored binding see.
const decided = holder.value !== null;
if (call() !== null) order.push("if");
console.log(decided, call() !== null ? "yes" : "no", Boolean(call() !== undefined));

console.log(order.join(","));
