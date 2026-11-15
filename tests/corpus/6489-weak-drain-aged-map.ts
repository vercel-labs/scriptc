// WeakMaps that grow old before the garbage that holds them goes.
//
// A depot keeps its lockers for a few hundred rounds, long enough for every
// collector pass in between to find them alive, and then hands each to a
// pair of clerks who hold each other and are dropped at once: the locker's
// WeakMap is older than the cycle that is its last holder, and it is freed
// when that young cycle is. Until then every round files a new key in an old
// locker, with a ticket that names the key, an earlier key, or the locker
// itself, so the old collection is freed full of entries of every age whose
// values hold its keys. Every twentieth round forces a collector pass, so
// the lockers age whatever the collector's own schedule would have done.
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

class Coat {
  tag: number;
  constructor(tag: number) {
    this.tag = tag;
  }
}

class Ticket {
  readonly coat: Coat;
  readonly before: Coat | null;
  readonly locker: Locker | null;
  constructor(coat: Coat, before: Coat | null, locker: Locker | null) {
    this.coat = coat;
    this.before = before;
    this.locker = locker;
  }
}

class Locker {
  readonly tickets: WeakMap<Coat, Ticket> = new WeakMap();
  readonly wet: WeakSet<Coat> = new WeakSet();
  last: Coat | null = null;
  filed: number = 0;
}

class Clerk {
  locker: Locker | null = null;
  mate: Clerk | null = null;
}

const lockers: Array<Locker> = [];
let sum = 0;

function file(locker: Locker, n: number): void {
  const coat = new Coat(n);
  const before = locker.last;
  locker.tickets.set(coat, new Ticket(coat, n % 3 === 0 ? before : null, n % 4 === 0 ? locker : null));
  if (n % 2 === 0) locker.wet.add(coat);
  if (n % 5 === 0) locker.last = coat;
  locker.filed++;
  sum += locker.tickets.get(coat)!.coat.tag % 3;
}

function retire(locker: Locker): void {
  const a = new Clerk();
  const b = new Clerk();
  a.mate = b;
  b.mate = a;
  a.locker = locker;
  sum += locker.filed;
}

function round(n: number): void {
  const slot = (n - 1) % 150;
  if (lockers.length <= slot) lockers.push(new Locker());
  const locker = lockers[slot];
  file(locker, n);
  file(locker, n + 1);
  if (n % 20 === 0) churn(200);
  if (n % 13 === 0 && n > 400) {
    lockers[slot] = new Locker();
    retire(locker);
  }
}

for (let i = 1; i <= 4000; i++) {
  round(i);
}
let filed = 0;
for (const locker of lockers) filed += locker.filed;
console.log('aged map', sum, filed);
