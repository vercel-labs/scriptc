// A module namespace taken as a checked-dynamic value: Node's export keys,
// live reads, function typeof, member calls, `in`, for-in, JSON, the
// [object Module] tag, the read-only write TypeErrors and the "Cannot
// convert object to primitive value" coercion, plus `Promise<namespace>`
// widening into `Promise<unknown>` and `unknown`.
import * as declared from "./mod.ts";
import * as expressionDefault from "./mod-default.ts";

function keys(value: unknown): string {
  return Object.keys(value as any).join(",");
}

function describe(value: unknown): void {
  const dyn = value as any;
  console.log("keys", keys(value));
  console.log("kinds", valueKinds(value));
  console.log("names", Object.getOwnPropertyNames(dyn).join(","));
  console.log("alpha", dyn.alpha, typeof dyn.beta, typeof dyn.default);
  console.log("call", dyn.beta());
  console.log("tag", Object.prototype.toString.call(dyn));
  console.log("in", "alpha" in dyn, "toString" in dyn);
  const forIn: string[] = [];
  for (const key in dyn) forIn.push(key);
  console.log("for-in", forIn.join(","));
  console.log("json", JSON.stringify(dyn));
  try {
    console.log("string", String(dyn));
  } catch (error) {
    console.log("string threw", (error as Error).message);
  }
  try {
    dyn.alpha = 2;
    console.log("write", dyn.alpha);
  } catch (error) {
    console.log("write threw", (error as Error).message);
  }
  try {
    dyn.gamma = 2;
    console.log("add", dyn.gamma);
  } catch (error) {
    console.log("add threw", (error as Error).message);
  }
  console.log("live", dyn.alpha);
}

function valueKinds(value: unknown): string {
  const dyn = value as any;
  const kinds: string[] = [];
  for (const key of Object.keys(dyn)) kinds.push(typeof dyn[key]);
  return kinds.join(",");
}

function bump(value: unknown): void {
  const dyn = value as any;
  dyn.bump();
  console.log("after bump", dyn.count);
}

async function main(): Promise<void> {
  // An expression default is snapshotted once by the export statement;
  // the boxed namespace's `default` read answers that value, like Node.
  const boxedDefault: unknown = expressionDefault;
  const dynDefault = boxedDefault as any;
  console.log("expression default", dynDefault.default, typeof dynDefault.default);
  console.log("expression keys", keys(boxedDefault), expressionDefault.default);
  describe(declared);
  bump(declared);
  const loaded = await import("./mod.ts");
  console.log("same", loaded === declared);
  describe(loaded);
  const widened: Promise<unknown> | undefined = import("./mod.ts");
  if (widened) console.log("widened", keys(await widened));
  const boxed: unknown = import("./mod.ts");
  console.log("unknown", keys(await boxed));
}

main();
