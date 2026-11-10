// Members of an untyped value after a class test: a parcel sorter whose belt
// holds values of every kind. Inside `if (item instanceof Parcel)` the reads,
// calls and optional links on `item` must answer as Node does whatever the
// item is: a parcel, an instance of a class below or beside it, a value boxed
// through its base type, a plain object with the same members, an object that
// inherits from a parcel, a frozen parcel, or something a class's own
// `Symbol.hasInstance` accepts.
class Parcel {
  label: string;
  weight: number;
  next: Parcel | undefined;
  tags: string[];
  constructor(label: string, weight: number) {
    this.label = label;
    this.weight = weight;
    this.next = undefined;
    this.tags = [label];
  }
  cost(rate: number): number {
    return this.weight * rate;
  }
  get heavy(): boolean {
    return this.weight > 10;
  }
}
class Crate extends Parcel {
  slats: number;
  constructor(label: string, weight: number, slats: number) {
    super(label, weight);
    this.slats = slats;
  }
  cost(rate: number): number {
    return this.weight * rate + this.slats;
  }
}
class Pallet extends Crate {
  layers = 2;
}
class Envelope {
  stamp: number;
  constructor(stamp: number) {
    this.stamp = stamp;
  }
  cost(rate: number): number {
    return this.stamp + rate;
  }
}
// A class tree wider than the capsule test compares in line.
class Bin {
  depth: number;
  constructor(depth: number) {
    this.depth = depth;
  }
}
class Bin1 extends Bin {}
class Bin2 extends Bin {}
class Bin3 extends Bin {}
class Bin4 extends Bin1 {}
class Bin5 extends Bin1 {}
class Bin6 extends Bin2 {}
class Bin7 extends Bin2 {}
class Bin8 extends Bin3 {}
class Bin9 extends Bin4 {}
class Bin10 extends Bin9 {
  lid = 'shut';
}
// Accepts anything that carries a `seal`.
class Sealed {
  seal: string;
  constructor(seal: string) {
    this.seal = seal;
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && 'seal' in value;
  }
}

function show(what: string, f: () => unknown): void {
  try {
    console.log(what + ': ' + String(f()));
  } catch (e) {
    console.log(what + ': threw ' + (e instanceof Error ? e.name + ': ' + e.message : String(e)));
  }
}

function weigh(item: unknown): unknown {
  if (item instanceof Parcel) return item.weight;
  return 'no parcel';
}
function name(item: unknown): unknown {
  if (item instanceof Parcel) return item.label;
  return 'no parcel';
}
function twice(item: unknown): unknown {
  if (item instanceof Parcel) return item.weight + item.weight;
  return 'no parcel';
}
function otherwise(item: unknown): unknown {
  if (!(item instanceof Parcel)) return 'no parcel';
  else return item.label + '/' + item.weight;
}
function both(item: unknown): unknown {
  return item instanceof Parcel && item.weight > 4;
}
function early(item: unknown): number {
  if (!(item instanceof Parcel)) return -1;
  return item.weight;
}
function linked(item: unknown): unknown {
  if (item instanceof Parcel) return item.next?.weight ?? 'unlinked';
  return 'no parcel';
}
function tagged(item: unknown): unknown {
  if (item instanceof Parcel) return item.tags.length + ':' + item.tags.join('+');
  return 'no parcel';
}
function tagList(item: unknown): unknown {
  if (item instanceof Parcel) return item.tags;
  return 'no parcel';
}
function priced(item: unknown): unknown {
  if (item instanceof Parcel) return item.cost(3);
  return 'no parcel';
}
function heavy(item: unknown): unknown {
  if (item instanceof Parcel) return item.heavy;
  return 'no parcel';
}
function crate(item: unknown): unknown {
  if (item instanceof Crate) return item.slats + '/' + item.cost(1);
  return 'no crate';
}
function pallet(item: unknown): unknown {
  if (item instanceof Pallet) return item.layers;
  return 'no pallet';
}
function sorted(item: unknown): unknown {
  switch (true) {
    case item instanceof Envelope:
      return 'envelope ' + item.stamp;
    case item instanceof Pallet:
      return 'pallet ' + item.layers;
    case item instanceof Crate:
      return 'crate ' + item.slats;
    case item instanceof Parcel:
      return 'parcel ' + item.weight;
    default:
      return 'unsorted';
  }
}
function binned(item: unknown): unknown {
  if (item instanceof Bin10) return 'bin10 ' + item.lid + ' ' + item.depth;
  if (item instanceof Bin1) return 'bin1 ' + item.depth;
  if (item instanceof Bin) return 'bin ' + item.depth;
  return 'no bin';
}
function sealed(item: unknown): unknown {
  if (item instanceof Sealed) return item.seal;
  return 'unsealed';
}
function relabel(item: unknown): unknown {
  if (item instanceof Parcel) {
    item.label = item.label + '!';
    item.weight += 1;
    return item.label + '/' + item.weight;
  }
  return 'no parcel';
}

function every(what: string, item: unknown): void {
  show(what + ' weigh', () => weigh(item));
  show(what + ' name', () => name(item));
  show(what + ' twice', () => twice(item));
  show(what + ' otherwise', () => otherwise(item));
  show(what + ' both', () => both(item));
  show(what + ' early', () => early(item));
  show(what + ' linked', () => linked(item));
  show(what + ' tagged', () => tagged(item));
  show(what + ' tag list', () => tagList(item));
  show(what + ' crate', () => crate(item));
  show(what + ' pallet', () => pallet(item));
  show(what + ' sorted', () => sorted(item));
  show(what + ' binned', () => binned(item));
  show(what + ' sealed', () => sealed(item));
}
function everyCall(what: string, item: unknown): void {
  show(what + ' heavy', () => heavy(item));
  show(what + ' priced', () => priced(item));
  show(what + ' relabel', () => relabel(item));
  show(what + ' weigh again', () => weigh(item));
}

const first = new Parcel('first', 3);
const second = new Parcel('second', 12);
second.next = first;
const viaBase: Parcel = new Pallet('stacked', 40, 6);
const belt: unknown[] = [
  first,
  second,
  new Crate('boxed', 8, 4),
  new Pallet('piled', 30, 5),
  viaBase,
  new Envelope(2),
  new Bin(1),
  new Bin1(2),
  new Bin5(3),
  new Bin10(4),
  { label: 'loose', weight: 5, next: undefined, tags: ['loose'] },
  { seal: 'wax' },
  new Sealed('lead'),
  'a string',
  41,
  null,
  undefined,
  [first],
];
for (let i = 0; i < belt.length; i++) {
  every('belt ' + i, belt[i]);
  everyCall('belt ' + i, belt[i]);
}

// Objects that inherit from a parcel pass the class test without being one;
// their own members shadow the parcel's.
const heir: unknown = Object.create(new Parcel('parent', 6));
every('heir', heir);
const shadow: unknown = Object.setPrototypeOf({ label: 'own' }, new Parcel('under', 7));
every('shadow', shadow);

// A frozen parcel reads as any other and refuses the write.
const frozen = new Parcel('ice', 9);
Object.freeze(frozen);
every('frozen', frozen);
everyCall('frozen', frozen);

// A parcel held in a slot of its own type and handed over untyped.
const held: { slot: unknown } = { slot: second };
every('held', held.slot);

let total = 0;
for (let round = 0; round < 50; round++) {
  for (let i = 0; i < belt.length; i++) {
    const item = belt[i];
    if (item instanceof Parcel) total += item.weight + item.cost(2);
    else if (item instanceof Envelope) total += item.stamp;
    else if (item instanceof Bin) total += item.depth;
  }
}
console.log('total ' + total);
export {};
