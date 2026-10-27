// Generic wrappers returning their untyped result `as F`: async functions,
// records with unknown fields, and rejections passing through.
function trace<F extends (...args: any[]) => any>(name: string, fn: F): F {
  return ((...args: Parameters<F>) => {
    console.log("span", name);
    return fn(...args);
  }) as F;
}
function traceThis<F extends (...args: any[]) => any>(name: string, fn: F): F {
  return function (this: unknown, ...args: Parameters<F>) {
    const result: unknown = fn.apply(this, args);
    console.log("span", name, typeof result);
    return result;
  } as F;
}
function lookup(key: string): any {
  return key === "set" ? 7 : undefined;
}
const fetchCount = trace("fetchCount", async (base: number): Promise<number> => {
  await null;
  return base + 1;
});
const fetchUser = traceThis("fetchUser", async (id: string): Promise<{ id: string; admin: boolean }> => ({
  id,
  admin: id === "root",
}));
const fails = trace("fails", async (why: string): Promise<number> => {
  throw new Error(why);
});
const summarize = trace("summarize", (limit = lookup("unset") ?? 2) => ({ kept: limit, dropped: 1 }));
const measure = traceThis("measure", (n: number) => ({ size: n, label: lookup("set") }));
async function main(): Promise<void> {
  console.log(await fetchCount(1));
  const user = await fetchUser("root");
  console.log(user.id, user.admin);
  try {
    await fails("nope");
  } catch (e) {
    console.log("caught", e instanceof Error ? e.message : String(e));
  }
  const s = summarize();
  console.log(s.kept, s.dropped, summarize(5).kept);
  const m = measure(3);
  console.log(m.size, m.label);
  const pending = fetchCount(10);
  console.log("before");
  console.log(await pending);
}
main();
export {};
