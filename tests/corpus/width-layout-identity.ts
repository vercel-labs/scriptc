// An array or record passed to a parameter, returned, or bound to a const
// under a type that lacks some of its optional fields stays the same value:
// identity comparisons and writes through any of the names see one object.

interface Entry {
  key: string;
  hits: number;
  note?: string;
}
type Counted = { key: string; hits: number };

function same(list: Counted[], other: Entry[]): boolean {
  return (list as unknown) === other;
}
function keep(list: Counted[]): Counted[] {
  return list;
}
function first(list: Counted[]): Counted {
  return list[0]!;
}
function grow(list: Counted[], key: string): Counted[] {
  list.push({ key, hits: 0 });
  return list;
}

const entries: Entry[] = [{ key: "a", hits: 1, note: "first" }];
console.log(same(entries, entries), keep(entries) === entries, first(entries) === entries[0]);
const grown = grow(entries, "b");
grown.push({ key: "c", hits: 2 });
console.log(grown === entries, entries.length, entries.map((e) => e.key).join(","));

function local(list: Entry[]): boolean {
  const view: Counted[] = list;
  const kept = keep(list);
  view[0]!.hits += 10;
  return view === list && kept === list;
}
console.log(local(entries), entries[0]!.hits, entries[0]!.note);

// An annotated const that kept its initializer's layout is that value when it
// is passed on: the callee's writes reach both names.
function track(list: Counted[], key: string): void {
  list.push({ key, hits: 0 });
}
function viaAlias(): string {
  const source: Entry[] = [{ key: "s", hits: 1, note: "kept" }];
  const view: Counted[] = source;
  track(view, "t");
  return `${view.length} ${source.length} ${view === source}`;
}
console.log(viaAlias());
const moduleSource: Entry[] = [{ key: "m", hits: 1 }];
const moduleView: Counted[] = moduleSource;
track(moduleView, "n");
console.log(moduleView.length, moduleSource.length, moduleView === moduleSource);

// The same function body lowered for a wider argument and for its own type:
// each lowering passes its own binding on.
function addTwice(list: Counted[], key: string): number {
  const alias: Counted[] = list;
  track(alias, key);
  track(alias, `${key}2`);
  return list.length;
}
const wideList: Entry[] = [{ key: "w", hits: 1, note: "n" }];
const plainList: Counted[] = [{ key: "p", hits: 1 }];
console.log(addTwice(wideList, "a"), addTwice(plainList, "b"), addTwice(wideList, "c"));
console.log(wideList.length, plainList.length);
