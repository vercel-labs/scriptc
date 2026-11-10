// The keys the runtime tracks itself, in a WeakMap that dies on a cycle.
//
// A stall's ledger is a WeakMap of `object` keys: parsed objects, functions,
// arrays and other collections, each filed with a value that holds its key.
// Stalls hold each other in pairs and are dropped every round, some after
// waiting a while, so the ledger is freed with the garbage that holds it and
// frees its keys through its values as it goes. A class instance filed under
// the same ledger shares the walk with them. Every fifth round forces a
// collector pass while the round's stalls are alive, which ages their
// ledgers ahead of the stalls.
class Mote {
  other: Mote | null = null;
}

// Dead two-object cycles: enough of them make the collector run a pass over
// the young objects while the caller's locals are alive.
function churn(n: number): void {
  for (let i = 0; i < n; i++) {
    const a = new Mote();
    const b = new Mote();
    a.other = b;
    b.other = a;
  }
}

class Stall {
  readonly ledger: WeakMap<object, unknown> = new WeakMap();
  readonly marked: WeakSet<object> = new WeakSet();
  next: Stall | null = null;
  sales: number = 0;
}

class Fruit {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}

type Bill = {item: object; n: number};

const waiting: Array<Stall> = [];
let sum = 0;

function sell(stall: Stall, n: number): void {
  const parsed: object = JSON.parse('{"n":' + n + ',"list":[1,2,3]}');
  const call: object = (): number => n;
  const list: object = [n, n + 1];
  const fruit = new Fruit(n);
  const inner: WeakMap<object, unknown> = new WeakMap();
  const bill: Bill = {item: parsed, n};
  stall.ledger.set(parsed, bill);
  stall.ledger.set(call, {item: call, n});
  stall.ledger.set(list, {item: parsed, n});
  stall.ledger.set(fruit, {item: list, n});
  inner.set(parsed, {item: fruit, n});
  stall.ledger.set(inner, {item: inner, n});
  stall.marked.add(parsed);
  stall.marked.add(call);
  stall.sales++;
  sum += stall.ledger.has(parsed) && stall.ledger.has(call) && stall.ledger.has(list) ? 1 : 0;
  sum += stall.ledger.has(fruit) && stall.ledger.has(inner) && stall.marked.has(call) ? 1 : 0;
  const read = stall.ledger.get(parsed) as Bill;
  sum += read.n % 3;
}

function round(n: number): void {
  const a = new Stall();
  const b = new Stall();
  a.next = b;
  b.next = a;
  sell(a, n);
  sell(b, n + 1);
  if (n % 5 === 0) churn(200);
  const slot = n % 100;
  if (waiting.length <= slot) waiting.push(a);
  else {
    sell(waiting[slot], n + 2);
    if (n % 3 === 0) waiting[slot] = b;
  }
}

for (let i = 1; i <= 1500; i++) {
  round(i);
}
let sales = 0;
for (const stall of waiting) sales += stall.sales;
console.log('wide keys', sum, sales);
