// Generator parameter initializers run at the CALL, in source order, before
// the statement that follows the call — and they never run again on .next().
const log: string[] = [];

function note(name: string): string {
  log.push(name);
  return name;
}

function* defaults(
  first: string = note("first"),
  second: string = note("second"),
): Generator<string, void, unknown> {
  log.push("body");
  yield first + "/" + second;
}

const gens = defaults();
log.push("after call");
console.log(log.join(",")); // first,second,after call — the body has not run
console.log(gens.next().value as string);
console.log(log.join(",")); // …body appended; no initializer ran twice
console.log(gens.next().done === true);

// Supplied arguments skip their own initializers but keep the order of the
// rest.
const partial = defaults("given");
console.log(log.join(","));
console.log(partial.next().value as string);
console.log(partial.next().done === true);

// A destructuring pattern's whole-object default runs at the call too.
function* patterned({ a, b = note("b") }: { a: string; b?: string } = {
  a: note("whole"),
}): Generator<string, void, unknown> {
  log.push("patterned body");
  yield a + "/" + b;
}
const withDefault = patterned();
console.log(log.join(",")); // …,whole — before the body
console.log(withDefault.next().value as string);
console.log(withDefault.next().done === true);
const supplied = patterned({ a: "x" });
console.log(supplied.next().value as string);
console.log(supplied.next().done === true);

// An initializer that throws throws at the call, not at .next().
function fail(): number {
  throw new Error("initializer failed");
}
function* throwing(value: number = fail()): Generator<number, void, unknown> {
  log.push("throwing body");
  yield value;
}
try {
  throwing();
  console.log("no throw");
} catch (e) {
  console.log("call threw", (e as Error).message);
}
console.log(log.includes("throwing body"));

// The earlier initializer's side effects are visible to the later ones.
function* ordered(a: string = note("x"), b: string = a + note("y")): Generator<
  string,
  void,
  unknown
> {
  yield b;
}
const orderedGen = ordered();
console.log(orderedGen.next().value as string);
console.log(orderedGen.next().done === true);
console.log("done");
