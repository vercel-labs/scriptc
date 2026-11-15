// Sharp probe: a Promise EXECUTOR and a String.replace REPLACER that the
// runtime runs synchronously inside a function whose call is a call region.
// The function values live in module constants, so the calls under test have
// no operand that allocates: on main both calls are call regions.
class Item {
  label: string;
  next: Item | null = null;
  constructor(label: string) {
    this.label = label;
  }
}
function show(it: Item | null): string {
  return it === null ? '-' : it.label + (it.next === null ? '' : '>' + it.next.label);
}
function make(tag: string, i: number): Item {
  const it = new Item(tag + i);
  it.next = new Item(tag + 'n' + i);
  return it;
}
const saved: Item[] = [];
let seq = 0;
const executor = (resolve: (v: number) => void): void => {
  saved.push(make('ex', seq++));
  resolve(1);
};
const replacer = (m: string): string => {
  saved.push(make('re', seq++));
  return m.toUpperCase();
};
function viaExecutor(n: number): number {
  const mine: Item[] = [];
  for (let i = 0; i < n; i++) {
    mine.push(make('own', i));
    if (i % 10 === 3) void new Promise<number>(executor);
  }
  return mine.length;
}
function viaReplacer(text: string, n: number): number {
  const mine: Item[] = [];
  let c = 0;
  for (let i = 0; i < n; i++) {
    mine.push(make('own', i));
    if (i % 10 === 3) c += text.replace(/a/g, replacer).length;
  }
  return mine.length + c;
}
let total = 0;
for (let r = 0; r < 40; r++) total += viaExecutor(14 + (r % 3));
for (let r = 0; r < 40; r++) total += viaReplacer('banana', 14 + (r % 3));
console.log(total, saved.length);
console.log(saved.slice(0, 40).map(show).join(' '));
console.log(saved.slice(-40).map(show).join(' '));
