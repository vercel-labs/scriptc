// @dynamic
async function sleepResolve(v: number, ms: number): Promise<number> {
  await new Promise<void>((r) => setTimeout(r, ms));
  return v;
}
async function sleepReject(msg: string, ms: number): Promise<number> {
  await new Promise<void>((r) => setTimeout(r, ms));
  throw new Error(msg);
}

const ps: Promise<number>[] = [sleepResolve(1, 5), sleepReject("oops", 10), sleepResolve(3, 2)];
const results = await Promise.allSettled(ps);
console.log(results.length === 3);
console.log(results[0]!.status === "fulfilled");
console.log(results[1]!.status === "rejected");
console.log(results[2]!.status === "fulfilled");
console.log("done");

const empty: Promise<number>[] = [];
const emptyResults = await Promise.allSettled(empty);
console.log(emptyResults.length === 0);

// Set spread variant like ai-core
const s = new Set<Promise<number>>([sleepResolve(10, 1), sleepResolve(20, 1)]);
const setResults = await Promise.allSettled([...s]);
console.log(setResults.length === 2);
