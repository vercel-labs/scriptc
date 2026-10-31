// A typed array's length and byteLength read just before the view's last
// reference goes away: the values stay those of the old view after a field
// replaces it, a map entry is deleted, or a local is rebound.
function grow(slots: Int32Array): Int32Array {
  const next = new Int32Array(slots.length * 2);
  next.set(slots);
  return next;
}

class Table {
  slots: Int32Array = new Int32Array(4);
  count = 0;
  add(value: number): number {
    const slots = this.slots;
    slots[this.count % slots.length] = value;
    this.count++;
    if (this.count === slots.length) this.slots = grow(slots);
    return this.slots.length;
  }
  swap(): number {
    const slots = this.slots;
    this.slots = new Int32Array(1);
    return slots.length;
  }
  swapBytes(): number {
    const slots = this.slots;
    const bytes = slots.byteLength;
    this.slots = new Int32Array(2);
    return bytes + slots.length;
  }
}

const table = new Table();
let size = 0;
for (let i = 0; i < 9; i++) size = table.add(i);
console.log(size, table.swap(), table.slots.length, table.add(5));
console.log(table.swapBytes(), table.slots.length);

const views = new Map<string, Float64Array>();
views.set("a", new Float64Array(6));
function take(key: string): number {
  const view = views.get(key);
  if (view === undefined) return -1;
  const length = view.length;
  views.delete(key);
  return length + view.byteLength;
}
console.log(take("a"), take("a"), views.size);

let current = new Uint8Array(3);
function rebind(): number {
  const old = current;
  current = new Uint8Array(old.length + 1);
  return old.length * 10 + current.length;
}
console.log(rebind(), rebind(), current.length);
