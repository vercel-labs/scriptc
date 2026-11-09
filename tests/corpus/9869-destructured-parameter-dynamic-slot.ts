// A binding of a destructured parameter whose type has no static form (a
// member that is an overload set) is a checked-dynamic slot, as the same
// binding in a declaration statement is: the function, method, static
// method or constructor that declares it still lowers its body. No package
// and no Node island: the type is the program's own.
interface Picker {
  (x: number): number;
  (x: string): string;
}
type Scale = { title: string; pick: Picker };
type ScaleFactory = (options: Record<string, unknown>) => Scale;

const pick = ((x: unknown) => (typeof x === "number" ? x * 2 : `${String(x)}!`)) as Picker;
const builtIn: ScaleFactory = (options) => ({ title: String(options.title), pick });
const loud: ScaleFactory = (options) => ({ title: String(options.title).toUpperCase(), pick });

function weigh({ scaleFactory }: { scaleFactory?: ScaleFactory }): string {
  const scale = (scaleFactory ?? builtIn)({ title: "declared" });
  return `${scale.title} ${scale.pick(21)} ${scale.pick("kg")}`;
}

function weighNoted({
  label = () => "noted",
  scaleFactory,
  unit = "g",
}: {
  label?: () => string;
  scaleFactory?: ScaleFactory;
  unit?: string;
}): string {
  const scale = (scaleFactory ?? builtIn)({ title: label() });
  return `${scale.title} ${scale.pick(unit)}`;
}

function weighNested({ deps: { scaleFactory } }: { deps: { scaleFactory?: ScaleFactory } }): string {
  return (scaleFactory ?? builtIn)({ title: "nested" }).title;
}

function weighFirst([scaleFactory]: [ScaleFactory?]): string {
  return (scaleFactory ?? builtIn)({ title: "first" }).title;
}

class Bench {
  readonly title: string;
  constructor({ scaleFactory }: { scaleFactory?: ScaleFactory }) {
    this.title = (scaleFactory ?? builtIn)({ title: "constructor" }).title;
  }
  weigh({ scaleFactory }: { scaleFactory?: ScaleFactory }): string {
    return `${this.title}/${(scaleFactory ?? builtIn)({ title: "method" }).title}`;
  }
  static weigh({ scaleFactory }: { scaleFactory?: ScaleFactory }): number {
    return (scaleFactory ?? builtIn)({ title: "static" }).pick(4);
  }
}

console.log(weigh({}));
console.log(weigh({ scaleFactory: loud }));
console.log(weighNoted({}));
console.log(weighNoted({ scaleFactory: loud, label: () => "relabelled", unit: "kg" }));
console.log(weighNested({ deps: {} }), weighNested({ deps: { scaleFactory: loud } }));
console.log(weighFirst([]), weighFirst([loud]));
console.log(new Bench({}).weigh({}), new Bench({ scaleFactory: loud }).weigh({ scaleFactory: loud }));
console.log(Bench.weigh({}), Bench.weigh({ scaleFactory: loud }));
