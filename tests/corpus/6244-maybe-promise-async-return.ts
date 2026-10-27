// Returning a maybe-promise value from async code flattens it: the
// promise arm is adopted (the extra then-job turns of a returned promise),
// any other arm fulfills directly. Covers block bodies, concise arrow
// bodies, `return await`, and then handlers.

type MaybeString = string | Promise<string>;
const settled: Promise<string> = Promise.resolve("settled");
function choose(kind: number): MaybeString {
  if (kind === 0) return "plain";
  if (kind === 1) return settled;
  return new Promise<string>((resolve) => setTimeout(() => resolve("timer"), 1));
}

async function viaReturn(kind: number): Promise<string> {
  return choose(kind);
}
async function viaReturnAwait(kind: number): Promise<string> {
  return await choose(kind);
}
const viaArrow = async (kind: number): Promise<string> => choose(kind);

const log: string[] = [];
let tick = 0;
function ticker(turns: number): void {
  if (turns === 0) return;
  Promise.resolve().then(() => {
    tick++;
    log.push("T" + tick);
    ticker(turns - 1);
  });
}

// A then handler returning a maybe-promise value: a cache that answers
// synchronously once loaded.
const cache = new Map<string, string>();
function load(key: string): string | Promise<string> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  return new Promise<string>((resolve) =>
    setTimeout(() => {
      cache.set(key, key.toUpperCase());
      resolve(key.toUpperCase());
    }, 1),
  );
}

ticker(10);
for (let kind = 0; kind < 3; kind++) {
  viaReturn(kind).then((v) => log.push("ret" + kind + ":" + v));
  viaReturnAwait(kind).then((v) => log.push("await" + kind + ":" + v));
  viaArrow(kind).then((v) => log.push("arrow" + kind + ":" + v));
}
const start = Promise.resolve("k");
start
  .then((key) => load(key))
  .then((v) => {
    log.push("first:" + v);
    return start.then((key) => load(key));
  })
  .then((v) => log.push("second:" + v));
setTimeout(() => console.log(log.join(" ")), 20);
