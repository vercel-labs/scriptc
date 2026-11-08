// A value of unknown type asserted to `undefined`, to `void`, and to a type
// argument that is one of them: the assertion checks that the value is
// undefined. Every value here is, so Node and the compiled program agree.
// (Values that are not undefined throw where Node goes on:
// tests/harness/unit-cast.test.ts.)

// A shelf of jars: a jar is empty (undefined) or holds what was put in it.
const shelf = new Map<string, unknown>([
  ["salt", undefined],
  ["count", 3],
  ["lid", { colour: "red" }],
]);
function jar(name: string): unknown {
  return shelf.get(name);
}

// `as undefined` on a value that is undefined.
const empty = jar("salt") as undefined;
console.log(empty === undefined, empty ?? "nothing inside", typeof empty);

// A generic function that asserts its result to its type argument,
// instantiated with void, with undefined and with a record type.
function lastOf<T>(steps: Array<() => unknown>): T {
  let last: unknown;
  for (const step of steps) last = step();
  return last as T;
}
lastOf<void>([() => jar("count"), () => jar("salt")]);
console.log("steps ran");
const nothing = lastOf<undefined>([() => jar("salt")]);
console.log(nothing === undefined);
const lid = lastOf<{ colour: string }>([() => jar("lid")]);
console.log(lid.colour);

// The same through a promise.
async function later<T>(name: string): Promise<T> {
  await Promise.resolve();
  return jar(name) as T;
}
await later<void>("salt");
const missing = await later<undefined>("missing");
console.log("waited", missing === undefined);

// A void function that returns the assertion.
function discard(name: string): void {
  return jar(name) as void;
}
discard("salt");
console.log("discarded");

// The default of `??` when the left side can only be null or undefined.
const labels = (jar("salt") as undefined) ?? ["unlabelled"];
console.log(labels.length, labels[0]);
let looks = 0;
function look(): unknown {
  looks += 1;
  return undefined;
}
const seen = (look() as undefined) ?? "empty";
console.log(seen, looks);

// As a member, as an argument and in a template.
const slot: { content: undefined; name: string } = { content: jar("salt") as undefined, name: "salt" };
console.log(slot.content, slot.name);
function weigh(grams: number | undefined): string {
  return grams === undefined ? "weightless" : String(grams);
}
console.log(weigh(jar("missing") as undefined), `${jar("salt") as undefined}`);
