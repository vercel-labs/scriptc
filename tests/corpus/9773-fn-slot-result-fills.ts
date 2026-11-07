// The ways a promise-or-value slot is filled with a function that answers a class instance: a
// member, a shorthand member, an optional member, a default parameter, defaults merged by spread,
// an object read back through a binding, a spread of one, an argument, a result, an array
// element, a class field, a generic slot, a generic function, bound functions, an arrow, a
// conditional and an assignment. Each reads the instance itself.
class Entry {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  label(): string {
    return `<${this.name}>`;
  }
}
type Slot = (name: string) => Promise<{ label: () => string }> | { label: () => string };
type Generic<T> = (name: string) => Promise<T> | T;
interface Ops {
  open: Slot;
}
interface Loose {
  open?: Slot;
}

const cache = new Map<string, Entry>();
function entryOf(name: string): Entry {
  let entry = cache.get(name);
  if (entry === undefined) {
    entry = new Entry(name);
    cache.set(name, entry);
  }
  return entry;
}
function now(name: string): Entry {
  return entryOf(name);
}
async function later(name: string): Promise<Entry> {
  return entryOf(name);
}
class Service {
  readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  open(name: string): Entry {
    return entryOf(this.prefix + name);
  }
  async openLater(name: string): Promise<Entry> {
    return entryOf(this.prefix + name);
  }
}
class Holder {
  open: Slot = later;
  quick: Slot = now;
}
function pick(ops: Ops = { open: later }): Ops {
  return ops;
}
const defaults: Ops = { open: later };
function merged(given: Partial<Ops> = {}): Ops {
  return { ...defaults, ...given };
}
function hold(open: Slot): Slot {
  return open;
}
function choose(quick: boolean): Slot {
  return quick ? now : later;
}
async function through<T>(open: Generic<T>, name: string): Promise<T> {
  return await open(name);
}

async function show(label: string, slot: Slot): Promise<void> {
  const value = await slot("a");
  const again = await slot("a");
  console.log(label, value.label(), value === again, (value as unknown) === cache.get("a") || (value as unknown) === cache.get("s:a"));
}

async function main(): Promise<void> {
  const service = new Service("s:");
  const holder = new Holder();
  const open = later;
  const member: Ops = { open: now };
  const shorthand: Ops = { open };
  const loose: Loose = { open: later };
  const base = { open: later };
  const read: Ops = base;
  const spread: Ops = { ...base };
  const quickBase = { open: now };
  const quickSpread: Ops = { ...quickBase };
  const elements: Slot[] = [now, later];
  const generic: Generic<{ label: () => string }> = later;
  const boundNow: Slot = now.bind(null);
  const boundMethod: Slot = service.open.bind(service);
  const boundLater: Slot = service.openLater.bind(service);
  const arrow: Slot = (name) => service.openLater(name);
  let assigned: Slot = now;
  if (cache.size === 0) assigned = later;

  await show("member", member.open);
  await show("shorthand", shorthand.open);
  if (loose.open !== undefined) await show("optional member", loose.open);
  await show("default parameter", pick().open);
  await show("defaults spread", merged().open);
  await show("defaults replaced", merged({ open: now }).open);
  await show("object read back", read.open);
  await show("spread", spread.open);
  await show("spread sync", quickSpread.open);
  await show("argument", hold(later));
  await show("result", choose(false));
  await show("result sync", choose(true));
  await show("element 0", elements[0]!);
  await show("element 1", elements[1]!);
  await show("class field", holder.open);
  await show("class field sync", holder.quick);
  await show("generic slot", generic);
  console.log("generic function", (await through<{ label: () => string }>(later, "a")).label());
  console.log("generic function sync", (await through<{ label: () => string }>(now, "a")).label());
  await show("bound", boundNow);
  await show("bound method", boundMethod);
  await show("bound async method", boundLater);
  await show("arrow", arrow);
  await show("assigned", assigned);
}
main();
