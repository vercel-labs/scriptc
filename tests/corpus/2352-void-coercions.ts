// Void-position value coercions, all Node-exact:
// - `return <value>` in a void-typed function evaluates and drops (JS
//   callers of a void slot never see the value)
// - `return undefined` / `return null` in a void function is a bare return
// - a `() => void` function in a `() => unknown` slot answers undefined
// - an async concise body whose value is a promise resolves through it
//   (`async () => p` fulfills with p's value, not a nested promise)

// return-a-value in a contextually void function: the call still happens.
let effects = 0;
const tick = (): number => {
  effects += 1;
  return effects;
};
let fv: () => void = () => {};
fv = () => tick();
fv();
fv();
console.log("effects", effects);

// return undefined / return null where the return type maps to void.
function retUndef(): void {
  return undefined;
}
function retNullish() {
  return null;
}
retUndef();
retNullish();
console.log("unit returns ok");

// A void function through an unknown-returning slot: calling through the
// slot yields undefined (the adapter hands over the engine's undefined).
const fu: () => unknown = () => {
  effects += 1;
};
const u = fu();
console.log("unknown-slot", typeof u, u === undefined, "effects", effects);

// Object-literal method returning undefined where the shape says void.
const box = {
  poke(): void {
    return undefined;
  },
};
box.poke();
console.log("method unit return ok");

// Concise void-returning arrows over conditional void calls lower as a
// branch, not a value ternary.
const branchVoid = (flag: boolean) => (flag ? box.poke() : fv());
branchVoid(true);
branchVoid(false);
console.log("branch-void", effects);

// Async concise body over an existing promise: resolves through.
async function inner(): Promise<number> {
  return 42;
}
const outer = async () => inner();
const typedOuter = async (): Promise<number> => inner();
async function main(): Promise<void> {
  console.log("outer", await outer());
  console.log("typedOuter", await typedOuter());
  // Block-bodied variant for parity.
  const blocky = async (): Promise<number> => {
    return inner();
  };
  console.log("blocky", await blocky());
}
main();
console.log("sync tail");
