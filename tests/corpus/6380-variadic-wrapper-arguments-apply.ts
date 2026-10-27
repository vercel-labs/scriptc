// A generic higher-order wrapper over `(...args: any) => any` that forwards
// `arguments` with `fn.apply(this, arguments)`, and types its options with
// Parameters<F> / ReturnType<F>. Each call site specializes the wrapper to
// the wrapped function's exact signature.
type AnyFn = (...args: any) => any;

interface TraceOptions<F extends AnyFn> {
  name?: string;
  tags?: (...args: Parameters<F>) => Record<string, string>;
  onResult?: (result: ReturnType<F>) => void;
}

function trace<F extends AnyFn>(fn: F, opts: TraceOptions<F> = {}): F {
  return function (this: unknown) {
    const args = arguments as unknown as Parameters<F>;
    const tags = opts.tags ? opts.tags(...args) : {};
    console.log("enter", opts.name ?? fn.name, JSON.stringify(tags));
    const result: ReturnType<F> = fn.apply(this, arguments as any);
    opts.onResult?.(result);
    console.log("exit", opts.name ?? fn.name);
    return result;
  } as F;
}

function add(a: number, b: number): number {
  return a + b;
}
const tracedAdd = trace(add, {
  tags: (a, b) => ({ a: String(a), b: String(b) }),
  onResult: (r) => console.log("result", r),
});
console.log(tracedAdd(2, 3));
console.log(tracedAdd(10, -4));

// A wrapped function with an optional parameter: the omitted position
// arrives as undefined, in the wrapper and its tags callback alike.
function titled(name: string, title?: string): string {
  return title ? `${title} ${name}` : name;
}
const tracedTitled = trace(titled, { tags: (name, title) => ({ name, title: title ?? "-" }) });
console.log(tracedTitled("ada"));
console.log(tracedTitled("ada", "dr"));

const greet = (who: string, punct: string): string => `hi ${who}${punct}`;
const tracedGreet = trace(greet);
console.log(tracedGreet("ada", "!"));

const tick = trace(function tick(): number {
  return 42;
});
console.log(tick());

interface Point {
  x: number;
  y: number;
}
const norm = trace((p: Point, scale: number): Point => ({ x: p.x * scale, y: p.y * scale }), {
  name: "norm",
  tags: (p) => ({ x: String(p.x) }),
});
console.log(JSON.stringify(norm({ x: 1, y: 2 }, 3)));

// The arguments tuple spread straight into an optional callback.
function audit<F extends AnyFn>(fn: F, check?: (...args: Parameters<F>) => boolean): F {
  return function (this: unknown) {
    console.log("audit", check?.(...(arguments as unknown as Parameters<F>)));
    return fn.apply(this, arguments as any);
  } as F;
}
const audited = audit(add, (a, b) => a < b);
console.log(audited(1, 2), audited(5, 3));
console.log(audit(add)(7, 8));

const logOnly = trace((msg: string): void => {
  console.log("log:", msg);
});
logOnly("done");
