// Array.fromAsync over async generators: plain, mapped, async-mapped, a
// throwing or rejecting mapping function (which closes the generator), a
// generator that throws, an empty generator, and two calls at once,
// interleaved with a microtask ticker. Node.js prints the same.
const log: string[] = [];
async function ticker(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    log.push("t" + i);
    await null;
  }
}
async function* nums(n: number): AsyncGenerator<number> {
  try {
    for (let i = 0; i < n; i++) {
      log.push("yield " + i);
      yield i;
    }
  } finally {
    log.push("gen finally");
  }
}
async function* failing(): AsyncGenerator<number> {
  yield 1;
  throw new Error("gen failure");
}
async function report(label: string, job: Promise<number[]>): Promise<void> {
  await job.then(
    (a) => log.push(label + " [" + a.join(",") + "]"),
    (e: unknown) => log.push(label + " rejected " + (e as Error).message),
  );
}
async function run(name: string, body: () => Promise<void>): Promise<void> {
  log.length = 0;
  const tick = ticker(20);
  await body();
  await tick;
  console.log(name + ": " + log.join(" "));
}
async function main(): Promise<void> {
  await run("plain", () => report("plain", Array.fromAsync(nums(3))));
  await run("map", () => report("map", Array.fromAsync(nums(3), (x: number, i: number) => x * 10 + i)));
  await run("async map", () => report("async map", Array.fromAsync(nums(2), async (x: number) => x + 1)));
  await run("map throws", () =>
    report("map throws", Array.fromAsync(nums(3), (x: number) => {
      if (x === 1) throw new Error("map failure");
      return x;
    })),
  );
  await run("map rejects", () =>
    report("map rejects", Array.fromAsync(nums(3), async (x: number) => {
      if (x === 1) throw new Error("async map failure");
      return x;
    })),
  );
  await run("generator throws", () => report("generator throws", Array.fromAsync(failing())));
  await run("empty", () => report("empty", Array.fromAsync(nums(0))));
  await run("two at once", async () => {
    await Promise.all([report("a", Array.fromAsync(nums(2))), report("b", Array.fromAsync(nums(1)))]);
  });
}
void main();
