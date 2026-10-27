// Generic arrow bindings declared inside functions, used by code that runs
// before or after the declaration: closures created above the declaration
// and hoisted function declarations read the binding like any const, so a
// use before the declaration throws a ReferenceError and a later one sees
// the function.
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function make(): (x: number) => number {
  const read = (): ((x: number) => number) => id;
  const id: (x: number) => number = <T>(x: T): T => x;
  return read();
}
console.log(make()(7));

function outer(flag: boolean): number {
  if (flag) return helper();
  const id: (x: number) => number = <T>(x: T): T => x;
  return helper();

  function helper(): number {
    return id(1);
  }
}
console.log(outer(false));
try {
  console.log(outer(true));
} catch (error) {
  console.log(describe(error));
}

function run(): void {
  const early = (): number => id(2);
  try {
    early();
  } catch (error) {
    console.log(describe(error));
  }
  const id: (x: number) => number = <T>(x: T): T => x;
  console.log(early());
}
run();

function counter(): () => number {
  let total = 0;
  const step = (): number => (total = add(total, 1));
  const add: (a: number, b: number) => number = <T extends number>(a: T, b: T): number => a + b;
  step();
  step();
  return step;
}
console.log(counter()());

// Each evaluation of the declaration makes a new function object.
const first = make();
console.log(first === make(), first === first, first(8));
function looped(): string {
  const seen: ((x: string) => string)[] = [];
  for (let i = 0; i < 2; i++) {
    const read = (): ((x: string) => string) => tag;
    const tag: (x: string) => string = function <T>(x: T): T {
      return x;
    };
    seen.push(read());
  }
  return `${seen[0] === seen[1]} ${seen[1]!("p")}`;
}
console.log(looped());
