// Stack-local values survive nested suspension, rejection, generator return,
// and repeated creation/destruction of native execution stacks.
async function nested(depth: number, seed: number): Promise<string> {
  const local = ["frame-" + depth, "seed-" + seed];
  await Promise.resolve(seed);
  if (depth === 0) return local.join(":");
  const inner = await nested(depth - 1, seed + 1);
  return local[0] + "/" + inner + "/" + local[1];
}

function* frames(seed: number): Generator<string, string, number> {
  const local = ["start-" + seed, "finish-" + seed];
  try {
    const sent = yield local[0];
    yield local[1] + ":" + sent;
    return local.join("/");
  } finally {
    if (seed < 2) console.log("cleanup", local[0]);
  }
}

async function run(): Promise<void> {
  const simultaneous = [nested(8, 1), nested(6, 100)];
  console.log((await Promise.all(simultaneous)).join(" | "));
  let total = 0;
  for (let i = 0; i < 120; i++) {
    const g = frames(i);
    total += String(g.next(0).value).length;
    total += String(g.next(i + 7).value).length;
    total += String(g.return("returned-" + i).value).length;
    total += (await nested(2, i)).length;
  }
  console.log("total", total);
  const parked = frames(300);
  console.log(parked.next(0).value);
  // The event loop can release spare stacks while this generator stays live.
  await new Promise<void>((resolve) => { setTimeout(() => resolve(), 5); });
  console.log(parked.next(17).value, parked.next(0).value);
  const completed = frames(200);
  console.log(completed.next(0).value, completed.next(9).value,
    completed.next(0).value, completed.next(0).done);
  try {
    await Promise.reject(new Error(await nested(1, 10)));
  } catch (error) {
    console.log(error instanceof Error ? error.message : "wrong error");
  }
}
run();
