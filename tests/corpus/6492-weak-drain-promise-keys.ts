// Promise keys in WeakMaps that die on a cycle.
//
// A kitchen files a docket under the promise of each order; the docket names
// the promise, so the entry's value holds its key. Kitchens hold each other
// in pairs and are dropped every round, with settled, pending and derived
// promises filed in them, and a few kitchens wait some rounds first. A
// promise is one key whichever view names it, so the docket filed under the
// typed promise is found again through `object`. Every fourth round forces
// a collector pass while the round's kitchens are alive, which ages their
// collections ahead of the kitchens.
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

class Docket {
  readonly order: Promise<number>;
  state: string = 'new';
  constructor(order: Promise<number>) {
    this.order = order;
  }
}

class Kitchen {
  readonly dockets: WeakMap<Promise<number>, Docket> = new WeakMap();
  readonly wide: WeakMap<object, unknown> = new WeakMap();
  readonly rush: WeakSet<Promise<number>> = new WeakSet();
  pair: Kitchen | null = null;
  orders: number = 0;
}

const waiting: Array<Kitchen> = [];
let sum = 0;
let served = 0;

async function cook(n: number): Promise<number> {
  return n * 2;
}

function order(kitchen: Kitchen, n: number): void {
  const settled: Promise<number> = Promise.resolve(n);
  const cooking: Promise<number> = cook(n);
  const pending: Promise<number> = new Promise<number>(() => {});
  const derived: Promise<number> = settled.then((v: number): number => {
    served++;
    return v + 1;
  });
  kitchen.dockets.set(settled, new Docket(settled));
  kitchen.dockets.set(cooking, new Docket(settled));
  kitchen.dockets.set(pending, new Docket(pending));
  kitchen.dockets.set(derived, new Docket(cooking));
  const asObject: object = cooking;
  kitchen.wide.set(asObject, {order: cooking, n});
  kitchen.rush.add(pending);
  kitchen.orders++;
  sum += kitchen.dockets.get(settled)!.order === settled ? 1 : 0;
  sum += kitchen.dockets.has(derived) && kitchen.wide.has(cooking) && kitchen.rush.has(pending) ? 1 : 0;
}

function round(n: number): void {
  const a = new Kitchen();
  const b = new Kitchen();
  a.pair = b;
  b.pair = a;
  order(a, n);
  order(b, n + 1);
  if (n % 4 === 0) churn(200);
  const slot = n % 80;
  if (waiting.length <= slot) waiting.push(a);
  else {
    order(waiting[slot], n + 2);
    if (n % 3 === 0) waiting[slot] = b;
  }
}

async function main(): Promise<void> {
  for (let i = 1; i <= 1200; i++) {
    round(i);
    if (i % 100 === 0) await cook(i);
  }
  await cook(0);
  let orders = 0;
  for (const kitchen of waiting) orders += kitchen.orders;
  console.log('promise keys', sum, orders, served);
}

main();
