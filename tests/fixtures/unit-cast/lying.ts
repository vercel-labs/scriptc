// A value of unknown type that is NOT undefined, asserted to `undefined`, to
// `void`, and to a type argument that is one of them. Each assertion throws
// the checked conversion's TypeError; Node erases the assertion and goes on
// (tests/harness/unit-cast.test.ts).
const shelf = new Map<string, unknown>([
  ["count", 3],
  ["lid", { colour: "red" }],
  ["gap", null],
  ["tag", "spice"],
  ["rows", [1]],
]);
function jar(name: string): unknown {
  return shelf.get(name);
}
function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "passed");
  } catch (error) {
    console.log(label, (error as Error).name, (error as Error).message);
  }
}
function lastOf<T>(steps: Array<() => unknown>): T {
  let last: unknown;
  for (const step of steps) last = step();
  return last as T;
}
async function later<T>(name: string): Promise<T> {
  await Promise.resolve();
  return jar(name) as T;
}
attempt("number as undefined", () => void (jar("count") as undefined));
attempt("record as void", () => void (jar("lid") as void));
attempt("null as undefined", () => void (jar("gap") as undefined));
attempt("string as undefined", () => {
  const tag = jar("tag") as undefined;
  console.log(tag ?? "unreached");
});
attempt("generic void", () => lastOf<void>([() => jar("lid")]));
attempt("generic undefined", () => void lastOf<undefined>([() => jar("rows")]));
try {
  await later<void>("lid");
  console.log("promised void passed");
} catch (error) {
  console.log("promised void", (error as Error).name, (error as Error).message);
}
