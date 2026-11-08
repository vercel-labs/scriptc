// @requires-libnode
// Native combinators over island promises held at their promise types,
// mixed with native promises: Promise.all, allSettled, race and any settle
// as in Node, and an island promise the program only holds is not reported
// when island code handles it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s: string): void => console.log(s);
const delayed = (ms: number, v: string): Promise<string> => new Promise((r) => setTimeout(() => r(v), ms));
const failing = (ms: number, m: string): Promise<string> =>
  new Promise((_, r) => setTimeout(() => r(new Error(m)), ms));
const island = (ms: number, v: string): Promise<string> => lib.delayed(ms, v);
const islandNow = (v: string): Promise<string> => lib.now(v);
const islandFailing = (ms: number, m: string): Promise<string> => lib.failing(ms, m);
const islandFailed = (m: string): Promise<string> => lib.failed(m);

async function main(): Promise<void> {
  log(`all ${(await Promise.all([delayed(30, "n30"), island(10, "i10"), islandNow("i0"), Promise.resolve("n0")])).join(" ")}`);
  try {
    await Promise.all([failing(20, "n-fail"), islandFailing(5, "i-fail"), island(40, "i40")]);
  } catch (e) {
    log(`all rejected ${(e as Error).message}`);
  }
  log(`race ${await Promise.race([delayed(10, "n10"), island(30, "i30")])}`);
  log(`race ${await Promise.race([delayed(30, "n30"), island(10, "i10")])}`);
  log(`race settled ${await Promise.race([islandNow("i0"), Promise.resolve("n0")])}`);
  log(`race settled ${await Promise.race([Promise.resolve("n0"), islandNow("i0")])}`);
  try {
    await Promise.race([islandFailing(5, "race i-fail"), delayed(30, "n30")]);
  } catch (e) {
    log(`race rejected ${(e as Error).message}`);
  }
  const entries: Promise<string>[] = [failing(20, "n-fail"), islandFailing(5, "i-fail"), island(40, "i40")];
  const settled = await Promise.allSettled(entries);
  log(`settled ${settled.map((x) => (x.status === "fulfilled" ? x.value : `!${(x.reason as Error).message}`)).join(" ")}`);
  log(`any ${await Promise.any([failing(20, "n-fail"), islandFailing(5, "i-fail"), island(40, "i40")])}`);
  try {
    await Promise.any([failing(5, "a"), islandFailing(1, "b")]);
  } catch (e) {
    const many = e as AggregateError;
    log(`any rejected ${many.name} ${many.errors.map((x: Error) => x.message).join(",")}`);
  }
  // Already settled entries of both sides: the first rejection in input order wins.
  try {
    await Promise.all([Promise.reject<string>(new Error("n first")), islandFailed("i second")]);
  } catch (e) {
    log(`all settled entries ${(e as Error).message}`);
  }
  try {
    await Promise.all([islandFailed("i first"), Promise.reject<string>(new Error("n second"))]);
  } catch (e) {
    log(`all settled entries ${(e as Error).message}`);
  }
  // Held at its promise type and handled by island code only.
  const held: Promise<string> = lib.selfHandled(5, "held", log);
  const kept: Promise<string>[] = [held];
  await delayed(30, "");
  log(`end ${kept.length}`);
}

void main();
