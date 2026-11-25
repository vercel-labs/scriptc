// Promise.all over entries that may be undefined — the `?.` shape
// (`Promise<void> | undefined`). Node's Promise.all fulfills an undefined
// entry with undefined instead of skipping or rejecting it, and the result
// keeps input order whatever order the entries settle in. Differential
// against Node, so output must be byte-exact.

function later(label: string, turns: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let remaining = turns;
    const tick = () => {
      remaining -= 1;
      if (remaining === 0) resolve(label);
      else Promise.resolve().then(tick);
    };
    Promise.resolve().then(tick);
  });
}

interface Conn {
  close(): Promise<void>;
}

const open: Conn | undefined = { close: async () => console.log("closed open") };
const missing: Conn | undefined = undefined;

async function tuple(): Promise<void> {
  // `connection?.close()` types as Promise<void> | undefined.
  const results = await Promise.all([later("a", 2), open?.close(), missing?.close()]);
  console.log("tuple", results.length, results[0], results[1], results[2]);

  // The unit entry beside typed promises settles as undefined.
  const kind: Promise<void> | undefined = undefined;
  const done: Promise<void> | undefined = Promise.resolve();
  const both = await Promise.all([done, kind]);
  console.log("unit", both.length, both[0], both[1]);
}

async function arrays(): Promise<void> {
  const entries: (Promise<void> | undefined)[] = [
    later("x", 3).then(() => undefined),
    undefined,
    later("y", 1).then(() => undefined),
    undefined,
  ];
  await Promise.all(entries);
  console.log("array settled", entries.length);

  // A mapped optional chain is the same shape.
  const conns: (Conn | undefined)[] = [open, missing, open];
  await Promise.all(conns.map((conn) => conn?.close()));
  console.log("mapped settled");

  const none: (Promise<void> | undefined)[] = [];
  await Promise.all(none);
  console.log("empty settled");
}

async function rejections(): Promise<void> {
  const good: Promise<void> | undefined = Promise.resolve();
  const bad: Promise<void> | undefined = Promise.reject(new Error("nope"));
  try {
    await Promise.all([good, bad, undefined]);
    console.log("unexpected");
  } catch (error) {
    console.log("rejected", (error as Error).message);
  }
  // Every entry counts as handled once the combinator settles.
  process.on("unhandledRejection", (reason) => console.log("unhandled", String(reason)));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  console.log("after");
}

async function main(): Promise<void> {
  await tuple();
  await arrays();
  await rejections();
  console.log("done");
}

main();
