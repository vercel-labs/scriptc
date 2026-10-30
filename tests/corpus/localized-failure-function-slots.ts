// Localized failure, stage L2: parameters and returns of arrows, function
// expressions and generic instances become checked dynamic slots.
type Hook = Map<string, (x: number) => string> | AbortSignal | (() => number) | Set<string>;

interface Model<T> {
  id: T;
  hook: Hook;
}

function retry<T>(label: string, request: () => Promise<T> | Hook): T | string {
  const r = request();
  return typeof r === "function" ? label + ":" + String(r()) : label + ":other";
}

function describe<T>(model: Model<T>): string {
  return `${String(model.id)}/${model.hook instanceof Set ? model.hook.size : typeof model.hook}`;
}

const run = (hook: Hook, n: number): string => (typeof hook === "function" ? String(hook() + n) : "set");
const make = function (size: number): Hook {
  return new Set(Array.from({ length: size }, (_, i) => `k${i}`));
};

console.log(run(() => 40, 2), run(new Set(["a"]), 1));
const h = make(3);
console.log(h instanceof Set ? h.size : -1);
console.log(retry("a", () => () => 7), retry<number>("b", () => new Set<string>()));
console.log(describe({ id: 5, hook: new Set(["x", "y"]) }), describe({ id: "s", hook: () => 1 }));
