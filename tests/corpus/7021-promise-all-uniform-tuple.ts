// `const pair = await Promise.all([p, q])` over entries of one promise
// type: the checker types the binding as a tuple, and the values arrive
// on the same microtask turn as Node's, in entry order whatever the
// settlement order.
const order: string[] = [];
function later(label: string, turns: number): Promise<string> {
  return new Promise((resolve) => {
    let left = turns;
    const step = (): void => {
      if (left-- === 0) {
        order.push(`settle ${label}`);
        resolve(`${label}!`);
      } else queueMicrotask(step);
    };
    step();
  });
}
async function count(n: number): Promise<number> {
  return n * 10;
}

async function main(): Promise<void> {
  let ticking = true;
  void (async () => {
    for (let i = 0; i < 20 && ticking; i++) {
      order.push(`t${i}`);
      await null;
    }
  })();
  const bodies = await Promise.all([later("a", 3), later("b", 1)]);
  order.push(`bodies ${bodies[0]} ${bodies[1]} ${bodies.length}`);
  const numbers = await Promise.all([count(1), count(2), count(3)]);
  const [x, y, z] = numbers;
  order.push(`numbers ${x + y + z} ${numbers.length}`);
  const annotated: [string, string] = await Promise.all([later("c", 0), later("d", 0)]);
  order.push(`annotated ${annotated.join("+")}`);
  ticking = false;
  console.log(order.join("\n"));
  try {
    const failed = await Promise.all([later("e", 2), Promise.reject<string>(new Error("no"))]);
    console.log("unreachable", failed[0]);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}
void main();
