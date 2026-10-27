// Promise.all over entries of different types settles, and resumes its
// awaits and then callbacks, on the same microtask turns as Node, whether
// the result is awaited at once, stored first, chained with then, or
// returned from an async function. The first rejection in settlement
// order wins, later ones count as handled, and record entries keep their
// identity.
const log: string[] = [];
function later<T>(label: string, turns: number, value: T, fail = false): Promise<T> {
  return new Promise((resolve, reject) => {
    let left = turns;
    const step = (): void => {
      if (left-- > 0) return queueMicrotask(step);
      log.push(`settle ${label}`);
      if (fail) reject(new Error(label));
      else resolve(value);
    };
    step();
  });
}
async function num(): Promise<number> {
  return 1;
}
async function text(): Promise<string> {
  return "s";
}
async function both(): Promise<[number, string]> {
  return Promise.all([num(), text()]);
}
const thenable: any = {
  get then() {
    log.push("then getter");
    return (resolve: (v: number) => void) => resolve(1);
  },
};
function evaluated(): Promise<string> {
  log.push("second entry evaluated");
  return Promise.resolve("s");
}
interface Item {
  id: number;
}
const item: Item = { id: 7 };

async function main(): Promise<void> {
  let ticking = true;
  void (async () => {
    for (let i = 0; i < 40 && ticking; i++) {
      log.push(`t${i}`);
      await null;
    }
  })();
  const [a, b] = await Promise.all([num(), text()]);
  log.push(`awaited ${a}${b}`);
  const stored = Promise.all([text(), num(), Promise.resolve(item)]);
  const [c, d, e] = await stored;
  log.push(`stored ${c}${d} ${e === item}`);
  Promise.all([text(), num()]).then(([f, g]) => log.push(`then ${f}${g}`));
  const [h, i] = await both();
  log.push(`returned ${h}${i}`);
  const mixed = await Promise.all([later("x", 3, "x"), 5, later("y", 1, true), undefined]);
  log.push(`mixed ${mixed[0]} ${mixed[1]} ${mixed[2]} ${mixed[3]}`);
  // A dynamic entry's `then` getter runs after the whole array evaluated.
  const [fromThenable, second] = await Promise.all([thenable, evaluated()]);
  log.push(`thenable ${fromThenable} ${second}`);
  const raw: any = JSON.parse('{"value":41}');
  const [dynamic, counted] = await Promise.all([raw.value, later("z", 2, 2)]);
  log.push(`dynamic ${dynamic + counted}`);
  // A Date entry's payload is its time value.
  const [when, label] = await Promise.all([later("date", 1, new Date(86400000)), text()]);
  log.push(`date ${when.toISOString()} ${label}`);
  try {
    await Promise.all([later("late", 4, 1, true), later("early", 2, "e", true), num()]);
  } catch (err) {
    log.push(`rejected ${(err as Error).message}`);
  }
  await later("tail", 6, 0);
  ticking = false;
  console.log(log.join("\n"));
}
void main();
