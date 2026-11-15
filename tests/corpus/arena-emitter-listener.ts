// Family probe: a LISTENER that an EventEmitter runs synchronously inside
// emit(), while the emitting function's arena is open, keeps what it
// allocates in a module array.
import { EventEmitter } from 'node:events';
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
const em = new EventEmitter();
em.on('item', (i: number) => {
  saved.push(make('em', i));
});
function viaEmit(e: EventEmitter, n: number): number {
  const mine: Item[] = [];
  for (let i = 0; i < n; i++) {
    mine.push(make('own', i));
    if (i % 10 === 3) e.emit('item', i);
  }
  return mine.length;
}
let total = 0;
for (let r = 0; r < 40; r++) total += viaEmit(em, 14 + (r % 3));
console.log(total, saved.length);
console.log(saved.slice(0, 40).map(show).join(' '));
