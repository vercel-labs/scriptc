// Chained assignment: the right-hand assignment is an EXPRESSION whose value
// feeds the outer store, so every target in the chain receives the same
// value and the whole chain yields it. Variables, dotted and bracketed
// class fields, optional interface members, index-signature records and
// array elements all take the chain — in statement position and in value
// position (a call argument, a declaration initializer). A unit right side
// (`void 0`) is a legitimate store into an undefined-armed slot, and the
// right side still evaluates exactly once.

let calls = 0;
function value(n: number): number {
  calls += 1;
  return n;
}

// Variables: the chain yields the assigned value and the right side
// evaluates once, not once per link.
let a: number | undefined;
let b: number | undefined;
a = b = value(5);
console.log("vars", a, b, calls);
a = b = void 0;
console.log("units", a, b);
const fromChain = (a = b = value(7));
console.log("yield", fromChain, a, b, calls);

class Box {
  x: number | undefined;
  y: number | undefined;
  tag: string | undefined;

  reset(): void {
    this.x = this.y = void 0;
  }
}
const box = new Box();
box.x = 1;
box.y = 2;
box.tag = "set";
console.log("class", box.x, box.y, box.tag);
box.reset();
console.log("reset", box.x, box.y);

// The bracket spelling of the same fields, in statement and value
// position.
class Bracketed {
  first: number | undefined;
  second: number | undefined;
  keep(): number | undefined {
    return (this.first = this.second = value(9));
  }
}
const bracketed = new Bracketed();
console.log("bracket", bracketed.keep(), bracketed.first, bracketed.second, calls);
bracketed["first"] = bracketed["second"] = void 0;
console.log("bracket units", bracketed.first, bracketed.second);

interface Pair {
  left?: number;
  right?: number;
}
const pair: Pair = {};
pair.left = pair.right = value(3);
console.log("pair", pair.left, pair.right, calls);
pair.left = pair.right = undefined;
console.log("pair units", pair.left, pair.right);

const record: Record<string, number | undefined> = {};
record["a"] = record["b"] = 4;
console.log("record", record["a"], record["b"]);
record["a"] = record["b"] = void 0;
console.log("record units", record["a"], record["b"], "b" in record);

const list: (number | undefined)[] = [1, 2, 3];
list[0] = list[1] = void 0;
console.log("array", JSON.stringify(list));
list[0] = list[1] = value(6);
console.log("array set", JSON.stringify(list), calls);

// Receiver and key evaluate once per link, before the right side, and the
// chain's value comes from the right side without a reread.
let receivers = 0;
function holder(): Box {
  receivers += 1;
  return box;
}
const once = (holder().x = holder().y = value(8));
console.log("once", once, receivers, box.x, box.y);

// A chain in a call argument: every link stores, and the callee sees the
// right side's value.
function take(n: number | undefined): string {
  return `${n}`;
}
console.log("arg", take((a = b = value(11))), a, b, calls);

// Null rides the same path into a null-armed slot.
const nullable: { v: number | null } = { v: 1 };
nullable.v = (null as number | null);
console.log("null", nullable.v);
