// A builtin member read as a value (`const f = o.toString`) takes the invoke
// unit's interned member table. A BigInt typed array selects the object model
// build of that unit (SCR_JS_OBJECT_MODEL) through the bytes it reads, while
// only a read of an intrinsic selects the intrinsic graph beside it, so this
// program links the table without the graph: the table's provider hook answers
// its fallback, and the member values read, call, and keep Node's receiver
// rule either way.
const bytes = new BigInt64Array(2);
bytes[0] = 7n;

const report = (label, fn) => {
  try {
    console.log(label, fn());
  } catch (error) {
    console.log(label, error.name + ": " + error.message);
  }
};

const parsed = JSON.parse('{"a":1,"b":2}');
const toString = parsed.toString;
const hasOwn = parsed.hasOwnProperty;
console.log(toString.call(parsed), hasOwn.call(parsed, "a"), hasOwn.call(parsed, "z"));

const map = new Map([["k", 1]]);
const get = map.get;
const set = map.set;
console.log(get.call(map, "k"), get.call(map, "z"), typeof get, typeof set);
set.call(map, "x", 2);
console.log(map.size, get.call(map, "x"));

// A member value keeps its receiver rule: a null receiver never reaches the
// table.
report("object toString on null", () => toString.call(null));

// The BigInt bytes that select the object model build keep their own values.
console.log(bytes.length, bytes[0], bytes[1], bytes.join("-"));
