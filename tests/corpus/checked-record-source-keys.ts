// A record converted from a checked value keeps the properties its type
// does not declare: the own-key tests, `in`, for...in and string
// conversion answer from them as they do for the source object.
type Plain = { a: number };

const parsed: Plain = JSON.parse('{"a":1,"extra":"x","more":[1]}');
console.log(parsed.hasOwnProperty("extra"), parsed.propertyIsEnumerable("more"), Object.hasOwn(parsed, "extra"));
console.log("extra" in parsed, "missing" in parsed, parsed.hasOwnProperty("missing"));
const keys: string[] = [];
for (const k in parsed) keys.push(k);
console.log(keys.join(","), Object.keys(parsed).join(","), `${parsed}`, parsed.toString());

const exact: Plain = JSON.parse('{"a":2}');
const exactKeys: string[] = [];
for (const k in exact) exactKeys.push(k);
console.log(exact.hasOwnProperty("extra"), "extra" in exact, exactKeys.join(","), `${exact}`);

// From an untyped value with methods of its own.
const untyped: unknown = {
  a: 3,
  toString() {
    return "custom";
  },
};
const fromUntyped = untyped as Plain;
console.log(`${fromUntyped}`, String(fromUntyped), fromUntyped.toString(), fromUntyped.hasOwnProperty("toString"));

// A checked record converted into a narrower type keeps both: its own
// undeclared properties and the ones its checked source kept.
type Pair = { a: number; b: number };
const pair: Pair = JSON.parse('{"a":4,"b":5,"c":6}');
const narrowed: Plain = pair;
console.log(Object.keys(narrowed).join(","), JSON.stringify(narrowed), "c" in narrowed, narrowed.hasOwnProperty("b"));
