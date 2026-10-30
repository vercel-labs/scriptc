// A generic method member whose own type parameter is CONSTRAINED by the
// enclosing type's type parameter (`run<T extends TApi>(item: Item<T>)`),
// implemented by a plain lambda: the lambda takes the interface signature's
// type parameters as its own and lowers once, erased like a generic lambda.
// `Item<T>`'s conditional member depends on the type argument each call
// passes, so the erased parameter must hold whatever the call sends.

type Api = "alpha" | "beta" | "gamma";

interface AlphaOptions {
  fast?: boolean;
}
interface BetaOptions {
  depth?: number;
}

interface Item<TApi extends Api> {
  id: string;
  api: TApi;
  options?: TApi extends "alpha" ? AlphaOptions : TApi extends "beta" ? BetaOptions : never;
}

interface Runner<TApi extends Api> {
  name: string;
  run<T extends TApi>(item: Item<T>): string;
}

function describe(item: Item<Api>): string {
  const options = item.options === undefined ? "-" : JSON.stringify(item.options);
  return `${item.id}:${item.api}:${options}`;
}

function makeRunner<TApi extends Api>(name: string): Runner<TApi> {
  return {
    name,
    run: (item) => `${name}:${describe(item)}`,
  };
}

const both = makeRunner<"alpha" | "beta">("both");
console.log(both.name);
console.log(both.run({ id: "a", api: "alpha", options: { fast: true } }));
console.log(both.run({ id: "b", api: "beta", options: { depth: 3 } }));
console.log(both.run({ id: "c", api: "alpha" }));
console.log(both.run<"beta">({ id: "d", api: "beta" }));

const all = makeRunner<Api>("all");
console.log(all.run({ id: "e", api: "gamma" }));
console.log(all.run({ id: "f", api: "beta", options: { depth: 1 } }));

// The same contract through a class body: the generic method lowers under
// the class instantiation's binding joined with its own type parameter.
class ClassRunner<TApi extends Api> implements Runner<TApi> {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  run<T extends TApi>(item: Item<T>): string {
    return `${this.name}:${describe(item)}`;
  }
}

const cls = new ClassRunner<"alpha" | "beta">("cls");
console.log(cls.run({ id: "g", api: "alpha", options: { fast: false } }));
console.log(cls.run({ id: "h", api: "beta" }));

// Record-held receivers call the erased slot the literal stored.
const runners: Runner<"alpha" | "beta">[] = [both, cls];
let combined = "";
for (const runner of runners) {
  combined += `[${runner.run({ id: "i", api: "alpha" })}]`;
}
console.log(combined);
