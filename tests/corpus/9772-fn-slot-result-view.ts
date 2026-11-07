// A function that answers a class instance, stored in a slot whose function type answers a
// structural shape: now, later, or either. The value read through the slot is the instance: its
// method runs on it, a later write shows through, and two reads are one object. A failing call
// throws or rejects with the function's own error.
class Entry {
  dir: boolean;
  constructor(dir: boolean) {
    this.dir = dir;
  }
  isDirectory(): boolean {
    return this.dir;
  }
}
interface Named {
  isDirectory(): boolean;
}
type Shape = { isDirectory: () => boolean };

const kept = new Entry(true);
const boom = new Error("boom");
function now(path: string): Entry {
  if (path === "!") throw boom;
  return kept;
}
async function later(path: string): Promise<Entry> {
  if (path === "!") throw boom;
  return kept;
}
function settled(path: string): Promise<Entry> {
  return path === "!" ? Promise.reject(boom) : Promise.resolve(kept);
}
function either(path: string): Promise<Entry> | Entry {
  if (path === "!") throw boom;
  return path === "later" ? Promise.resolve(kept) : kept;
}

// The promise-or-value slot, its two spellings of the shape written out as in an options record.
type Slot = (path: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
type NamedSlot = (path: string) => Promise<Named> | Named;
type PromiseSlot = (path: string) => Promise<Shape>;
type PlainSlot = (path: string) => Shape;

async function probe(label: string, slot: Slot): Promise<void> {
  const order: string[] = [];
  const first = (async () => {
    const value = await slot("later");
    order.push("slot");
    return value;
  })();
  const ticks = Promise.resolve()
    .then(() => order.push("1"))
    .then(() => order.push("2"))
    .then(() => order.push("3"))
    .then(() => order.push("4"));
  const value = await first;
  await ticks;
  const again = await slot("now");
  kept.dir = false;
  const flipped = value.isDirectory();
  kept.dir = true;
  let failure = "none";
  try {
    await slot("!");
  } catch (error) {
    failure = `${error === boom} ${(error as Error).message}`;
  }
  console.log(
    label,
    value.isDirectory(),
    flipped,
    value === again,
    (value as unknown) === kept,
    order.join(""),
    failure,
  );
}

async function main(): Promise<void> {
  await probe("now", now);
  await probe("later", later);
  await probe("settled", settled);
  await probe("either", either);
  // A literal in the same slot type answers a literal of the shape.
  let calls = 0;
  await probe("literal", (path) => {
    if (path === "!") throw boom;
    return {
      isDirectory: () => {
        calls++;
        return kept.dir;
      },
    };
  }).catch((error: unknown) => console.log("literal failed", (error as Error).message));
  console.log("literal calls", calls);

  const named: NamedSlot[] = [now, later, either];
  for (const slot of named) console.log("named", (await slot("later")).isDirectory());
  const promised: PromiseSlot[] = [later, settled];
  for (const slot of promised) {
    const value = await slot("x");
    console.log("promise slot", value.isDirectory(), (value as unknown) === kept);
  }
  const plain: PlainSlot = now;
  console.log("plain slot", plain("x").isDirectory(), (plain("x") as unknown) === kept);
  try {
    plain("!");
  } catch (error) {
    console.log("plain slot throws", error === boom);
  }

  // A promise of an instance held at a promise of the shape, with no function in between.
  const pending: Promise<Shape> = settled("x");
  const direct: Shape = kept;
  console.log("payload", (await pending) === direct, (await pending).isDirectory());
  const all: Promise<Shape>[] = [later("a"), settled("b")];
  for (const one of all) console.log("element", (await one).isDirectory());
  const rejected: Promise<Shape> = settled("!");
  await rejected.then(
    () => console.log("no rejection"),
    (error: unknown) => console.log("payload rejects", error === boom),
  );
}
main();
