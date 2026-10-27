// LifetimeRegion (@scriptc/experimental) across await in both forms an
// async body compiles to: a body that awaits only at its own awaits runs as
// a stackless coroutine, and one that drives an async generator with
// for await keeps a fiber. Each form spawns and awaits the other inside a
// region, requests interleave, and a region is released while its work is
// still pending; everything allocated after a resume stays in the region,
// so every region is freed (tests/harness/lifetime-regions.test.ts).
// Node.js prints the same.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

class Item implements ProgramLifetime {
  readonly name: string;
  next: Item | undefined = undefined;
  readonly tags: string[] = [];
  constructor(name: string) {
    this.name = name;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function names(head: Item | undefined): string {
  const out: string[] = [];
  for (let at = head; at !== undefined; at = at.next) out.push(`${at.name}[${at.tags.join("/")}]`);
  return out.join(",");
}

// Stackless: suspends only at its own awaits.
async function decorate(name: string, round: number): Promise<Item> {
  const item = new Item(name);
  await turn();
  item.tags.push(`r${round}`);
  await Promise.resolve();
  item.tags.push(`${name.length}`);
  return item;
}

async function* produce(prefix: string, n: number): AsyncGenerator<string> {
  for (let i = 0; i < n; i++) {
    await tick();
    yield `${prefix}${i}`;
  }
}

// Fiber: drives an async generator, and awaits stackless work per step.
async function streamed(prefix: string, n: number): Promise<Item | undefined> {
  let head: Item | undefined;
  let round = 0;
  for await (const name of produce(prefix, n)) {
    const item = await decorate(name, round++);
    item.next = head;
    head = item;
  }
  return head;
}

// Stackless again: awaits the fiber form, then keeps allocating.
async function request(id: number): Promise<string> {
  const first = await decorate(`q${id}`, 0);
  const chain = await streamed(`s${id}.`, 2 + (id % 2));
  first.next = chain;
  await tick();
  const last = new Item(`end${id}`);
  last.next = first;
  last.tags.push("done");
  return `#${id} ${names(last)}`;
}

async function serve(id: number): Promise<string> {
  const region = new LifetimeRegion();
  try {
    return await region.run(() => request(id));
  } finally {
    region.release();
  }
}

async function releasedWhilePending(): Promise<string> {
  const region = new LifetimeRegion();
  const pending = region.run(() => streamed("late.", 3));
  region.release();
  const head = await pending;
  return `released early: ${names(head)}`;
}

async function failing(): Promise<string> {
  const region = new LifetimeRegion();
  try {
    await region.run(async () => {
      const head = await streamed("f.", 2);
      await turn();
      throw new Error(`failed after ${names(head)}`);
    });
    return "no error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    region.release();
  }
}

async function main(): Promise<void> {
  const responses = await Promise.all([1, 2, 3, 4].map((id) => serve(id)));
  for (const r of responses) console.log(r);
  console.log(await releasedWhilePending());
  console.log(await failing());
  console.log(await serve(9));
}

main().catch((e) => {
  console.log("unexpected", String(e));
});
