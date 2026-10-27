// The type-safe variadic wrapper: rest tuples instead of `arguments`.
// `...args: A` with A bound to the wrapped function's parameter tuple
// flattens to that fixed signature; `fn.apply(this, args)`, `fn(...args)`
// and `opts.tags(...args)` forward the tuple's positions.
interface Opts<A extends unknown[], R> {
  name?: string;
  tags?: (...args: A) => Record<string, string>;
  onResult?: (r: R) => void;
}

function wrap<A extends unknown[], R>(fn: (...args: A) => R, opts: Opts<A, R> = {}): (...args: A) => R {
  return function (this: unknown, ...args: A): R {
    const tags = opts.tags ? opts.tags(...args) : {};
    console.log("enter", opts.name ?? fn.name, JSON.stringify(tags));
    const r = fn.apply(this, args);
    opts.onResult?.(r);
    return r;
  };
}

function viaSpread<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    console.log("spread", args.length);
    return fn(...args);
  };
}

function mul(a: number, b: number): number {
  return a * b;
}
const m = wrap(mul, { tags: (a, b) => ({ a: String(a), b: String(b) }), onResult: (r) => console.log("r", r) });
console.log(m(6, 7));

const concat = wrap((s: string, n: number, flag: boolean) => `${s}:${n}:${flag}`, { name: "concat" });
console.log(concat("x", 1, true));

const opt = wrap((s: string, n?: number) => `${s}:${n ?? "none"}`, { tags: (s, n) => ({ s, n: String(n) }) });
console.log(opt("a", undefined), opt("b", 2));

const zero = wrap(() => "nothing");
console.log(zero());

const spreadMul = viaSpread(mul);
console.log(spreadMul(3, 3));

// A concrete tuple rest parameter has the same fixed signature.
function pair(...args: [string, number]): string {
  return `${args[0]}=${args[1]}`;
}
console.log(pair("k", 9));
const asValue: (k: string, v: number) => string = pair;
console.log(asValue("v", 1));
const t: [string, number] = ["t", 2];
console.log(pair(...t));
