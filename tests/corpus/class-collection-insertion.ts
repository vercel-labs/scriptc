class Base { value = 1; }
class Child extends Base { extra = 2; }
const child = new Child();
const source: Child[] = [child];
const target: Base[] = [];

function insert(value: Child): void {
  console.log(target.push(value), target.unshift(value));
  console.log(target.splice(1, 0, value).length);
  const copied = target.toSpliced(1, 1, value);
  const replaced = target.with(0, value);
  const literal: Base[] = [value];
  console.log(copied.length, replaced.length, literal.length);
  console.log(copied[1] === value, replaced[0] === value, literal[0] === value);
  console.log(0 in literal, literal[0] === undefined);
}
insert(source[0]);
insert(source[4]);
console.log(target.length, target.filter((value): boolean => value === undefined).length);
console.log(0 in target, 1 in target, 2 in target);
const mapped: Base[] = source.map((value): Base => value);
console.log(mapped[0] === child);
const records = source.map((value) => ({ value: value as Base }));
console.log(records[0]!.value === child);

const sparse = new Array<Child>(3);
sparse[1] = child;
const widened: Base[] = [];
console.log(widened.push(...sparse));
console.log(widened[0] === undefined, widened[1] === child, widened[2] === undefined, 0 in widened, 2 in widened);
console.log(widened.unshift(...new Set([child, child])));
console.log(widened[0] === child);
const changed = widened.toSpliced(1, 1, ...sparse);
console.log(changed.length, changed[2] === child, 1 in changed, 3 in changed);
console.log(widened.splice(1, 2, ...sparse).length, widened.length);

const events: string[] = [];
const first = new Child();
const second = new Child();
first.value = 10;
second.value = 20;
const moving: Child[] = [first];
const out: Base[] = [];
function getTarget(): Base[] { events.push("receiver"); return out; }
function getSource(): Child[] { events.push("source"); return moving; }
function mutate(): Base { events.push("mutate"); moving[0] = second; return child; }
console.log(getTarget().push(...getSource(), mutate(), ...getSource()));
console.log(events.join(","), out.map((value) => value.value).join(","));
events.length = 0;
console.log(getTarget().unshift(...getSource()), events.join(","));
console.log(out[0] === second, out[1] === first);
first.value = 30;
console.log(out[1]!.value);

function fail(): Base { throw new Error("stop"); }
try { out.push(...source, fail()); } catch (error) {
  if (error instanceof Error) console.log(error.message);
}
console.log(out.length);

class Middle extends Base { middle = 3; }
class Leaf extends Middle { leaf = 4; }
const leaf = new Leaf();
const ancestors: (Base | Middle)[] = [new Base()];
const joined = ancestors.concat([leaf], [leaf]);
console.log(joined.length, joined[1] === leaf, joined.indexOf(leaf), joined[2] instanceof Leaf);

interface Span { min: number; max: number }
interface Entry { name: string; span: Span }
interface Slot { name: string; entry?: Entry }
const entries: Entry[] = [{ name: "first", span: { min: 0, max: 9 } }];
const slots: Slot[] = [{ name: "a", entry: entries[0] }, { name: "b", entry: entries[3] }];
function narrowed(slot: Slot): Entry | null {
  if (slot.entry) return { ...slot.entry, span: { min: 1, max: slot.entry.span.max } };
  return null;
}
console.log(JSON.stringify(slots.map(narrowed)), slots[0]!.entry === entries[0]);
