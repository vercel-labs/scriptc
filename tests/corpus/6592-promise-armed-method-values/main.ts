// Parse steps that answer either a status record or a promise of one keep
// their method values: reads through untyped code, detached calls, and the
// per-instance rebinding of the base constructor all see the function.
import { map, number, object, record, set, stepDetached, stepKinds } from "status-schema";
async function main(): Promise<void> {
  const shaped = object({ count: number(), size: number() });
  const counts = record(number());
  const byName = map(number());
  const seen = set(number());
  console.log(stepKinds(shaped), "|", stepKinds(counts), "|", stepKinds(byName), "|", stepKinds(seen));
  console.log(shaped.safeParse({ count: 1, size: 2 }).success, shaped.safeParse({ count: "x", size: 2 }).success);
  console.log(JSON.stringify(shaped.parse({ count: 3, size: 4 })));
  console.log(JSON.stringify(await shaped.parseAsync({ count: 5, size: 6 })), (await shaped.spa(7)).success);
  console.log(counts.safeParse({ a: 1, b: 2 }).success, (await counts.safeParseAsync({ a: "x" })).success);
  console.log(byName.safeParse(new Map([["a", 1]])).success, (await byName.safeParseAsync(new Map([["b", "x"]]))).success);
  console.log(seen.safeParse(new Set([1, 2])).success, (await seen.spa(new Set([3]))).success);
  console.log(await stepDetached(shaped, { count: 1, size: 1 }), "|", await stepDetached(counts, { a: "x" }));
  console.log(await stepDetached(byName, new Map([["c", 2]])), "|", await stepDetached(seen, [1]));
  try {
    await counts.parseAsync(null);
  } catch (e) {
    console.log("rejected", e instanceof Error ? e.message : String(e));
  }
  const nested = object({ inner: record(number()), tags: set(number()) });
  console.log(JSON.stringify(await nested.parseAsync({ inner: { q: 1 }, tags: new Set([1]) })));
}
main();
