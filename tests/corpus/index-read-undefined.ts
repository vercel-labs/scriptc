// A keyed read can be missing at run time even where the checker types it at
// the declared value type: a record index signature without a matching key,
// an array or tuple element past its length. The value's storage carries that
// absence, so the read, the default of `??` over it, and both arms of `?:`
// over it report undefined where Node does instead of failing to represent it.
// A member the receiver declares itself still reads as the declared type.

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const shown = (value: unknown): string => (value === undefined ? "undefined" : "defined");

const empty: JsonObject = {};
const filled: JsonObject = { count: 3, list: [1, 2], nested: { label: "deep" } };

function count(object: JsonObject): JsonValue {
  return object.count;
}

// The read itself.
console.log("missing", shown(count(empty)));
console.log("missing member", shown(empty.count));

// `??` with both sides absent, one side absent, and a longer chain.
console.log("both", shown(empty.a ?? empty.b));
console.log("fallback", empty.a ?? filled.count);
console.log("chain", empty.a ?? empty.b ?? 7);

// `?:` over two missing reads, and a missing read next to a present one.
console.log("conditional", shown(filled.count === 3 ? empty.left : empty.right));
console.log("conditional present", filled.count === 3 ? empty.left ?? filled.count : 0);

// The same reads through a mapped record and a nested index signature.
const mapped: Record<string, JsonValue> = {};
console.log("mapped", shown(mapped.key ?? empty.key));
console.log("nested", shown(filled.nested));
console.log("nested member", shown((filled.nested as JsonObject).label));

// Element reads miss the same way.
const values: JsonValue[] = [];
console.log("elements", shown(values[0] ?? values[1]));
const numbers: number[] = [5];
console.log("element present", numbers[1] ?? numbers[0]);
console.log("element missing", shown(numbers[1]));

// A widened read keeps its absence through an object literal and a call.
const boxed = { held: empty.a, kept: filled.count };
console.log("literal", shown(boxed.held));
console.log("literal present", boxed.kept);

// Destructuring, spreading and a parameter keep it too.
const { count: destructured } = empty;
console.log("destructured", shown(destructured));
const spread = { ...empty };
console.log("spread", shown(spread.count));
function counterOr(object: JsonObject, fallback: number): JsonValue {
  return object.count ?? fallback;
}
console.log("parameter", counterOr(empty, -1));
console.log("parameter present", counterOr(filled, -1));

// A declared union slot takes the absence too.
let assigned: JsonValue = null;
assigned = empty.a;
console.log("assigned", shown(assigned));

// A default that is itself a call returning a missing read.
const absent = empty.a;
console.log("call default", shown(absent ?? count(empty)));
