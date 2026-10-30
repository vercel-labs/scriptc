// Several promise arms in one union: `void | Promise<A> | Promise<void> |
// Decision` is one promise arm `Promise<A | undefined>` — `instanceof
// Promise` is true for either arm and `await` settles to the payload union.
interface Decision {
  kind: "stop" | "continue";
  note: string;
}

interface Settled {
  reason: string;
}

type TurnResult = void | Promise<Settled> | Promise<void> | Decision;

function pick(n: number): TurnResult {
  if (n === 0) return;
  if (n === 1) return Promise.resolve({ reason: "one" });
  if (n === 2) return Promise.resolve();
  return { kind: "continue", note: "x" };
}

function fail(): void | Promise<Settled> {
  return Promise.reject(new Error("boom"));
}

class Agent {
  finishTurn?: (turn: number) => TurnResult;

  async turn(n: number): Promise<string> {
    const hook = this.finishTurn;
    if (!hook) return "none";
    const out = await hook(n);
    if (out === undefined) return "void";
    if ("note" in out) return `decision:${out.note}`;
    return `settled:${out.reason}`;
  }
}

async function main(): Promise<void> {
  // A promise stored in the union is the same object: the payload
  // conversion never re-boxes it.
  const original = Promise.resolve({ reason: "one" });
  const stored: TurnResult = original;
  console.log("identity", stored === original);

  const hit = pick(1);
  console.log("promise", hit instanceof Promise, pick(3) instanceof Promise);
  if (hit instanceof Promise) {
    const settled = await hit;
    console.log("narrowed", settled === undefined ? "void" : "object");
    console.log("then", await hit.then((value) => (value === undefined ? "u" : "s")));
  }

  console.log("void", (await pick(0)) === undefined);
  const settled = await pick(1);
  console.log("awaited", typeof settled === "object" && "reason" in settled ? settled.reason : "?");
  const decided = await pick(3);
  console.log("decision", typeof decided === "object" && "note" in decided ? decided.note : "?");

  const empty = pick(2);
  if (empty instanceof Promise) await empty.then(() => console.log("then void"));

  try {
    await fail();
  } catch (error) {
    console.log("rejected", (error as Error).message);
  }

  const agent = new Agent();
  console.log("no hook", await agent.turn(1));
  agent.finishTurn = pick;
  console.log("hook", await agent.turn(1), await agent.turn(3), await agent.turn(0));
}
void main();
