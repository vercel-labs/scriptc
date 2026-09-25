// A member or property named `arguments` is not a read of the `arguments`
// object: arrows that spell one stay fixed-arity function values. The
// options shape is node-redis's eval(script, { keys, arguments }).

interface EvalOptions {
  keys: string[];
  arguments: string[];
}

const describe = (options: EvalOptions): string =>
  `${options.keys.join(",")} | ${options.arguments.join(",")}`;

// An object-literal key.
const literal = (): string => describe({ keys: ["k"], arguments: ["1", "2"] });
console.log(literal());

// A property signature in an inline type, and a destructured property name.
const typed = (value: number): number => {
  const holder: { arguments: number } = { arguments: value };
  const { arguments: count } = holder;
  return count * 2;
};
console.log(typed(21));

// Function values that carry them through higher-order calls.
const makers: (() => string)[] = [literal, () => describe({ keys: [], arguments: ["x"] })];
for (const make of makers) console.log(make());
console.log([1, 2, 3].map(typed).join(" "));
