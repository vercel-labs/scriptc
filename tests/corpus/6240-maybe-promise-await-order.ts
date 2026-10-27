// `await` on a maybe-promise union (`T | Promise<T>`): the promise arm
// resumes one turn after it settles, every other arm is a non-thenable that
// resumes after exactly one microtask turn with the value itself. A ticker
// chain interleaves with each await so the turn counts are observable.

type MaybeString = string | Promise<string>;

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

const settled: Promise<string> = Promise.resolve("settled");
function choose(kind: number): MaybeString {
  if (kind === 0) return "plain";
  if (kind === 1) return settled;
  // Settles two turns from now.
  return new Promise<string>((resolve) => {
    Promise.resolve().then(() => resolve("late"));
  });
}

async function awaitOnce(kind: number): Promise<void> {
  log.push("start" + kind);
  const value = await choose(kind);
  log.push("got" + kind + ":" + value);
}

async function awaitTwice(): Promise<void> {
  const first = await choose(0);
  const second = await choose(1);
  log.push("twice:" + first + "+" + second);
}

// A union with unit arms beside the data arm: `undefined` is a
// non-thenable too.
type MaybeCount = number | undefined | Promise<number | undefined>;
function count(kind: number): MaybeCount {
  return kind === 0 ? 7 : kind === 1 ? undefined : Promise.resolve(kind === 2 ? 9 : undefined);
}
async function counts(): Promise<void> {
  for (let kind = 0; kind < 4; kind++) {
    const value = await count(kind);
    log.push("count" + kind + ":" + String(value));
  }
}

ticker(12);
awaitOnce(0);
awaitOnce(1);
awaitOnce(2);
awaitTwice();
counts();
setTimeout(() => console.log(log.join(" ")), 5);
