// A generic function called with an array built from a compiled JavaScript
// package's values is instantiated at `any[]`: the package's functions are
// compiled from their JavaScript, where a schema's `properties` is untyped.
// The instance takes the array as a checked array of untyped elements, and
// from then on every `any[]` in the program has that layout. The seeds and
// folds below must keep working on it: a Set seeded from an untyped value
// the checker narrowed to `any[]`, and Math.min/Math.max over a spread
// `any[]`.
import { Count, Group, type Properties, Text } from "schema-kit";

const A = Group({ x: Text() });
const B = Group({ y: Count({ description: "n" }), z: Text() });
const table = { one: A, two: B, three: A } as const;

function mergeNames<G extends readonly Properties[]>(groups: G): string[] {
  const out: string[] = [];
  for (const group of groups) for (const key of Object.keys(group)) out.push(key);
  return out;
}

// The same schema appears twice in the table and once in the Set.
const merged = mergeNames([...new Set(Object.values(table))].map((schema) => schema.properties));
console.log(merged.join());
const seen = new Set(Object.values(table));
console.log(seen.size, seen.has(A), seen.has(B));

function requiredNames(schema: Record<string, unknown>): string[] {
  const names = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out: string[] = [];
  for (const name of ["x", "y"]) out.push(names.has(name) ? name : `${name}?`);
  if ([...names].some((key) => key === "zz")) out.push("zz!");
  return out;
}
console.log(requiredNames({ required: ["x"] }).join());
console.log(requiredNames({ required: ["y", "zz", "y"] }).join());
console.log(requiredNames({}).join());
console.log(requiredNames({ required: "xy" }).join());
console.log(requiredNames(A as unknown as Record<string, unknown>).join());

function describeFields(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const { type, properties, required } = schema as Record<string, unknown>;
  if (type !== "object" || typeof properties !== "object" || properties === null) return undefined;
  const requiredSet = new Set(Array.isArray(required) ? required : []);
  const fields = Object.keys(properties).map((name) => `${name}${requiredSet.has(name) ? "" : "?"}`);
  return `{ ${fields.join(", ")} }`;
}
console.log(describeFields(B));
console.log(describeFields({ type: "object", properties: { a: 1, b: 2 }, required: ["b"] }));
console.log(describeFields({ type: "object", properties: { a: 1 } }));
console.log(describeFields(7), describeFields(Text()));

// The elements keep their identity through the Set.
const first = { id: 1 };
const listed: unknown = [first, first, { id: 1 }];
const distinct = new Set(Array.isArray(listed) ? listed : []);
console.log(distinct.size, distinct.has(first));

function firstIndex(source: any): number | undefined {
  const indices = [source.indexOf("$"), source.indexOf("("), source.indexOf("[")].filter(
    (index) => index >= 0,
  );
  return indices.length > 0 ? Math.min(...indices) : undefined;
}
console.log(firstIndex("a $ b ( c"), firstIndex("none"), firstIndex("[ $"));

function extremes(values: any): string {
  const numbers = Array.isArray(values) ? values : [];
  return `${Math.min(...numbers)} ${Math.max(...numbers)}`;
}
console.log(extremes([3, 1, 2]), extremes([]), extremes(["4", 10]), extremes([1, "x"]), extremes(5));

// `new Array(n)` into a slot of untyped elements: a generic body bound to
// `unknown`, and an `unknown[]` local.
async function runAll<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  for (let i = 0; i < tasks.length; i++) results[i] = await tasks[i]!();
  return results;
}
const ran = await runAll<unknown>([async () => 1, async () => "two", async () => [3]]);
console.log(ran.length, JSON.stringify(ran));
const slots: unknown[] = new Array(2);
slots[1] = "filled";
console.log(slots.length, JSON.stringify(slots), 0 in slots, 1 in slots);
