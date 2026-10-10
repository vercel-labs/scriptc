import { Item, emptyItems } from "./items.ts";

export function compareLists(a: readonly Item[] | undefined, b: readonly Item[] | undefined): number {
  const x = a ?? emptyItems;
  const y = b ?? emptyItems;
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) {
    const r = x[i]!.name < y[i]!.name ? -1 : x[i]!.name > y[i]!.name ? 1 : 0;
    if (r !== 0) return r;
  }
  return 0;
}

/** Appends `count` fillers to `list`, which also owns `keep`, then reads `keep`. */
export function appendMany(list: Item[], keep: Item, count: number, filler: Item): number {
  for (let i = 0; i < count; i++) list.push(filler);
  return keep.name.length;
}

const ids = new Int32Array(new SharedArrayBuffer(4));

export function labelOf(item: Item): string {
  if (item.id === 0) item.id = Atomics.add(ids, 0, 1) + 1;
  return `${item.name}#${item.id}`;
}

export function snapshot(list: readonly Item[], extra: Item): Item[] {
  const head = list.slice(0, 2);
  const out = [extra, head[0]!, head[1]!];
  out.push(extra);
  return out;
}

/** Removes the element that also arrives as `keep`, then reads `keep`. */
export function shiftThenRead(list: Item[], keep: Item): string {
  const removed = list.shift()?.name.length ?? -1;
  return `${keep.name}/${removed}`;
}

/** Truncates the array that owns `keep`, then reads `keep`. */
export function truncateThenRead(list: Item[], keep: Item): string {
  list.length = 0;
  return keep.name;
}
