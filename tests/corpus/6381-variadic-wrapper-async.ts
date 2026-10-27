// Variadic generic wrappers around async functions: the wrapper forwards
// `arguments`, awaits the wrapped promise and reports its settled value
// through an Awaited<ReturnType<F>> callback; rejections propagate.
type AnyFn = (...args: any) => any;

interface Opts<F extends AnyFn> {
  name?: string;
  tags?: (...args: Parameters<F>) => Record<string, string>;
  onSettled?: (value: Awaited<ReturnType<F>>) => void;
}

function traceAsync<F extends (...args: any) => Promise<any>>(fn: F, opts: Opts<F> = {}): F {
  return async function (this: unknown) {
    const args = arguments as unknown as Parameters<F>;
    const tags = opts.tags ? opts.tags(...args) : {};
    console.log("start", opts.name ?? fn.name, JSON.stringify(tags));
    try {
      const value: Awaited<ReturnType<F>> = await fn.apply(this, arguments as any);
      opts.onSettled?.(value);
      console.log("ok", opts.name ?? fn.name);
      return value;
    } catch (e) {
      console.log("failed", opts.name ?? fn.name, (e as Error).message);
      throw e;
    }
  } as F;
}

// The settled result spelled as a conditional over ReturnType<F>.
type Settled<F extends AnyFn> = ReturnType<F> extends PromiseLike<infer U> ? U : ReturnType<F>;

function summarized<F extends (...args: any) => Promise<any>>(
  fn: F,
  summarize: (value: Settled<F>) => string,
): F {
  return async function (this: unknown) {
    const value: Settled<F> = await fn.apply(this, arguments as any);
    console.log("summary", summarize(value));
    return value;
  } as F;
}

async function fetchUser(id: number, prefix: string): Promise<string> {
  await Promise.resolve();
  if (id < 0) throw new Error(`bad id ${id}`);
  return `${prefix}${id}`;
}

const getUser = traceAsync(fetchUser, {
  tags: (id) => ({ id: String(id) }),
  onSettled: (v) => console.log("settled", v.toUpperCase()),
});

const sleepless = traceAsync(async (): Promise<number> => 7, { name: "seven" });

interface Report {
  ok: boolean;
  items: string[];
}
const report = summarized(
  async (count: number): Promise<Report> => ({ ok: count > 0, items: ["a", "b"].slice(0, count) }),
  (r) => `${r.ok}:${r.items.join("+")}`,
);
const counted = summarized(async (n: number): Promise<number> => n * 2, (n) => `n=${n + 1}`);

async function main(): Promise<void> {
  console.log(await getUser(1, "u-"));
  console.log(await sleepless());
  console.log(JSON.stringify(await report(1)));
  console.log(await counted(4));
  try {
    await getUser(-2, "u-");
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  const pending = getUser(3, "a-");
  const second = await getUser(4, "b-");
  console.log(second, await pending);
}

main().then(() => console.log("main done"));
