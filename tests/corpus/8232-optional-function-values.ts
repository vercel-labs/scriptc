// Values typed `F | undefined` for a function type F: identity and
// equality (signature adapters compare as the function they adapt), typeof,
// truthiness, storage in arrays, records, class fields and Maps, optional
// parameters and returns.
type Unary = (x: number) => number;
type Binary = (x: number, y: number) => number;

const double: Unary = (x) => x * 2;
const asBinary: Binary = double;
const maybe = (flag: boolean): Unary | undefined => (flag ? double : undefined);

const a = maybe(true);
const b = maybe(true);
const none = maybe(false);
console.log(a === b, a === none, none === undefined, typeof a, typeof none, !!a, !!none);
console.log(a === double, (asBinary as unknown) === (double as unknown));

const slots: (Unary | undefined)[] = [double, undefined, (x) => x + 1];
console.log(slots.map((f) => (f ? f(5) : "empty")).join(" "), slots.length);
console.log(slots.indexOf(double), slots.includes(undefined), slots.filter((f) => f !== undefined).length);

interface Hooks {
  before?: Unary;
  after?: Unary;
}
const hooks: Hooks = { after: (x) => x - 1 };
console.log(hooks.before?.(1) ?? "no before", hooks.after?.(1) ?? "no after", "before" in hooks);

class Button {
  onClick: Unary | undefined;
  clicks = 0;
  click(): number {
    this.clicks++;
    return this.onClick?.(this.clicks) ?? -1;
  }
}
const button = new Button();
console.log(button.click());
button.onClick = (n) => n * 100;
console.log(button.click(), button.click());
button.onClick = undefined;
console.log(button.click(), button.onClick === undefined);

const registry = new Map<string, Unary | undefined>([
  ["set", double],
  ["unset", undefined],
]);
console.log(registry.get("set")?.(4), registry.get("unset")?.(4), registry.has("unset"), registry.get("other") === undefined);

function run(x: number, transform?: Unary, combine?: Binary): number {
  const t = transform ? transform(x) : x;
  return combine === undefined ? t : combine(t, x);
}
console.log(run(3), run(3, double), run(3, undefined, (p, q) => p * q), run(3, (x) => -x, asBinary));

function pick(name: string): Binary | undefined {
  switch (name) {
    case "mul":
      return (x, y) => x * y;
    case "first":
      return (x) => x;
    default:
      return undefined;
  }
}
for (const name of ["mul", "first", "none"]) {
  const f = pick(name);
  console.log(name, f?.(6, 7), f === undefined ? "undefined" : typeof f);
}

let late: Unary | undefined;
const callLate = (): number => late?.(9) ?? 0;
console.log(callLate());
late = (x) => x + 0.5;
console.log(callLate());
