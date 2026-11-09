// Members of an untyped binding the checker narrowed to a class, read on an
// instance that holds an OWN property in front of a member of its class: a
// data property or another getter defined over a prototype accessor, and a
// function defined, assigned or copied over a prototype method. Every read
// must answer the own property, as Node does, and an instance without one
// must keep answering its class's member.
class Gauge {
  private n = 1;
  weight = 3;
  get size(): number {
    return this.n;
  }
  set size(v: number) {
    this.n = v * 10;
  }
  get label(): string {
    return 'gauge';
  }
  plain(): string {
    return 'method';
  }
  other(): string {
    return 'other';
  }
  third(): string {
    return 'third';
  }
}
class Dial extends Gauge {
  extra = 2;
}

function show(tag: string, u: unknown): void {
  if (u instanceof Gauge)
    console.log(tag, u.size, u.label, u.label.length, u.plain(), u.other(), u.third(), u.weight);
  else console.log(tag, 'no gauge');
}
function showDial(tag: string, u: unknown): void {
  if (u instanceof Dial) console.log(tag, u.size, u.label, u.extra, u.plain());
  else console.log(tag, 'no dial');
}

// A data property over a getter, on a typed binding and on an untyped one.
const typed = new Gauge();
show('typed before', typed);
Object.defineProperty(typed, 'size', { value: 42, configurable: true });
show('typed after', typed);
const untyped: unknown = new Gauge();
Object.defineProperty(untyped, 'label', { value: 'own', writable: true });
show('untyped after', untyped);

// The setter still runs for an instance without an own property; another
// getter defined on the instance answers afterwards.
const set: any = new Gauge();
set.size = 3;
show('set', set);
Object.defineProperty(set, 'size', { get: () => 99, configurable: true });
show('own getter', set);

// An inherited accessor, the key computed.
const dial: unknown = new Dial();
showDial('dial before', dial);
const key = 'si' + 'ze';
Object.defineProperty(dial, key, { value: 5 });
showDial('dial after', dial);
show('dial as gauge', dial);

// Own functions over prototype methods: defined, written by a computed key,
// copied by Object.assign (which also writes a declared field).
const defined: unknown = new Gauge();
Object.defineProperty(defined, 'plain', { value: () => 'defined' });
show('defined', defined);
const computed: any = new Gauge();
const name = 'oth' + 'er';
computed[name] = () => 'computed';
show('computed', computed);
const assigned: any = new Gauge();
Object.assign(assigned, { third: () => 'assigned', weight: 9 });
show('assigned', assigned);

// An instance nothing was defined on, after all of the above.
show('fresh', new Gauge());
showDial('fresh dial', new Dial());

let total = 0;
const belt: unknown[] = [typed, untyped, set, dial, defined, new Gauge(), new Dial(), 'text', 7];
for (let round = 0; round < 20; round++) {
  for (const item of belt) {
    if (item instanceof Gauge) total += item.size + item.weight + item.label.length;
  }
}
console.log('total ' + total);
export {};
