// Promise.race over Promise<T | undefined> and Promise<void>: the void
// entry fulfills the race with undefined.
interface Msg { id: string }
function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
function poll(ms: number, id: string | null): Promise<Msg | undefined> {
  return delay(ms, id === null ? undefined : { id });
}
function exited(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function main(): Promise<void> {
  const a = await Promise.race([poll(5, "m1"), exited(50)]);
  console.log("message first:", a ? a.id : "none");
  const b = await Promise.race([poll(50, "m2"), exited(5)]);
  console.log("exit first:", b === undefined, b ? b.id : "none");
  const c = await Promise.race([exited(5), poll(1, null)]);
  console.log("empty poll first:", c);
  const settled = Promise.resolve();
  const d = await Promise.race([settled, poll(0, "m3")]);
  console.log("settled void entry wins:", d);
  const n = await Promise.race([delay(20, 42), exited(1)]);
  console.log("number or void:", n);
  try {
    await Promise.race([poll(20, "late"), Promise.reject(new Error("boom"))]);
  } catch (e) {
    console.log("rejected:", (e as Error).message);
  }
}
void main();
