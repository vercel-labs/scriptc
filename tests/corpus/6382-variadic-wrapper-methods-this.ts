// Variadic generic wrappers on methods: the wrapper passes its own `this`
// through `fn.apply(this, arguments)`, so a wrapped `function (this: C)`
// stored as a class property sees the receiver it was called on.
type AnyFn = (...args: any) => any;

function logged<F extends AnyFn>(fn: F, label: string): F {
  return function (this: unknown) {
    console.log(`[${label}] call with ${arguments.length} args`);
    return fn.apply(this, arguments as any);
  } as F;
}

class Counter {
  count = 0;
  step: number;
  constructor(step: number) {
    this.step = step;
  }
  bump = logged(function (this: Counter, times: number): number {
    this.count += this.step * times;
    return this.count;
  }, "bump");
  reset = logged((): void => {
    this.count = 0;
  }, "reset");
}

const c = new Counter(5);
console.log(c.bump(1));
console.log(c.bump(2));
c.reset();
console.log(c.count);

class Repo {
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  load = logged(async function (this: Repo, id: string): Promise<string> {
    await Promise.resolve();
    return `${this.base}/${id}`;
  }, "load");
}

const repo = new Repo("https://x.test");
repo.load("7").then((url) => console.log("loaded", url));
