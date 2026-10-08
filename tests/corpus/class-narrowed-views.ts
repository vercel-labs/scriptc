abstract class Entry {
  revision = 0;
  abstract measure(): number;
}
class Folder extends Entry {
  name = "folder";
  items = [2, 4];
  measure(): number { return this.items.length; }
}
class Page extends Entry {
  padding = 17;
  items = [6];
  measure(): number { return this.padding; }
}
class SpecialFolder extends Folder {
  extra = 9;
  measure(): number { return this.extra; }
}
class UnusedWrapper extends Entry {
  inner: Entry;
  constructor(inner: Entry) { super(); this.inner = inner; }
  measure(): number { return this.inner.measure(); }
}
function inspect(entry: Entry): number {
  if (entry instanceof UnusedWrapper) return inspect(entry.inner);
  if (entry instanceof Folder) return entry.items.length + entry["name"].length;
  if (entry instanceof Page) return entry.padding;
  return -1;
}
function append(entry: Entry): number {
  if (entry instanceof Folder || entry instanceof Page) {
    entry.items.push(8);
    entry.revision = entry.items.length;
    return entry.items.length + entry.revision;
  }
  return -1;
}
function select(flag: boolean): Folder | Page {
  return flag ? new Folder() : new Page();
}
function replace(entry: Folder | Page, items: number[]): void {
  entry.items = items;
}
const folder = new Folder();
const page = new Page();
const special: Entry = new SpecialFolder();
console.log(inspect(folder), inspect(page), inspect(special), special.measure());
console.log(append(folder), append(page), append(special));
console.log(folder.items.join(","), page.items.join(","));
const selected = select(false);
replace(selected, [10, 20, 30]);
console.log(selected.items.length, selected.revision);
let current: Folder | Page = select(true);
const original = current;
let calls = 0;
function replacement(): number[] {
  calls++;
  current = new Page();
  return [40, 50];
}
current.items = replacement();
console.log(calls, original.items.join(","), current.items.join(","), original === current);
console.log(new UnusedWrapper(folder).measure());

// This class contributes a layout to narrowing but no live constructor.
class Dormant extends Entry {
  value = 100;
  measure(): number { return this.value; }
}
function dormant(entry: Entry): number {
  return entry instanceof Dormant ? entry.value : entry.measure();
}
console.log(dormant(folder), dormant(page));

const expressionTarget = select(false);
const assigned = (expressionTarget.items = [60, 70]);
console.log(assigned === expressionTarget.items, assigned.join(","));
