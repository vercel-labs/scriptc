// A function with only `unknown` parameters, or none, flows into a
// `(...args: unknown[]) => R` slot: each call passes the callers'
// arguments in order, undefined for a parameter the caller left out, and
// drops the extra ones, as JS calls do. Sync and async functions, stored
// in variables and arrays and passed as arguments.
type Handler = (...args: unknown[]) => void;
type AsyncHandler = (...args: unknown[]) => Promise<unknown>;

const none: Handler = () => console.log("none");
const one: Handler = (a: unknown) => console.log("one", a);
const two: Handler = (a: unknown, b: unknown) => console.log("two", a, b);

none();
none(1, 2, 3);
one();
one("x");
one("x", "y");
two(1);
two(1, [2], { three: 3 });

const handlers: Handler[] = [none, one, two];
for (const h of handlers) h("all", true);

function dispatch(h: Handler, ...args: unknown[]): void {
  h(...args);
}
dispatch(two, "spread", null);
dispatch(one);

const first: AsyncHandler = async (value: unknown) => value;
const pair: AsyncHandler = async (a: unknown, b: unknown) => [a, b];

async function main(): Promise<void> {
  console.log(await first(10, 20));
  console.log(await first());
  console.log(await pair("p"));
  console.log(await pair("p", "q", "r"));
}
main().then(() => console.log("done"));
