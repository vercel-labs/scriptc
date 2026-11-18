// A function expression whose rest parameter is `any[]` or `unknown[]` holds every argument the call passed in that one pack, so `arguments.length` is the pack's length. The closure keeps a single trailing slot — the checked-dynamic variadic ABI this value is boxed with — whether the call names the binding, goes through an alias, passes nothing, or spreads.
const anyRest = function (...args: any[]): string {
  return `${arguments.length}:${args.length}:${args.join("-")}`;
};

const unknownRest = function (...args: unknown[]): string {
  return `${arguments.length}:${args.length}`;
};

console.log(anyRest(1, 2), anyRest());

const alias = anyRest;
const many = [1, 2, 3];
console.log(anyRest(...many), alias("a", "b"), anyRest("x", ...many));

console.log(unknownRest("a"), unknownRest(), unknownRest(...many));
