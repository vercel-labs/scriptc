// Rest parameters typed `unknown[]` or `any[]` in function types: the
// handler registry of an extension host, with forwarding wrappers and
// spread calls.

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, HandlerFn[]>();
function on(event: string, handler: HandlerFn): () => void {
  const registered: HandlerFn = (...args) => handler(...args);
  const list = handlers.get(event) ?? [];
  list.push(registered);
  handlers.set(event, list);
  return () => {
    const current = handlers.get(event);
    if (!current) return;
    const index = current.indexOf(registered);
    if (index !== -1) current.splice(index, 1);
  };
}
async function emit(event: string, ...args: unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const h of handlers.get(event) ?? []) out.push(await h(...args));
  return out;
}

on("x", async (...args) => args.length);
const off = on("x", async (...args: unknown[]) => typeof args[0] + ":" + String(args[1]));
on("y", async (...args) => "no args " + args.length);

function sum(...nums: unknown[]): number {
  let total = 0;
  for (const n of nums) if (typeof n === "number") total += n;
  return total;
}
const stored: (...values: unknown[]) => number = sum;
const logAll: (...values: any[]) => void = (...values: any[]) => console.log(values.length, values[0]);

async function main(): Promise<void> {
  console.log(JSON.stringify(await emit("x", 1, "two", true)));
  off();
  console.log(JSON.stringify(await emit("x", 5)));
  console.log(JSON.stringify(await emit("y")));
  console.log(sum(1, 2, "x", 4), stored(5, 6), stored());
  logAll("p", "q");
  logAll();
}
main();
