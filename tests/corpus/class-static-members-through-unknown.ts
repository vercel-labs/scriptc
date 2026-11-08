// Static members of a class held as an `unknown` value: declared with a
// value, declared for the type only (`declare static`), declared without a
// value, and not declared at all; on the class and inherited; with a generic
// base class. Then a prototype method replaced through the dynamic value
// where no typed call can reach the declared method, and the identity of a
// generic class across its instantiations.

function isObject(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'object' && value !== null;
}
function isFunctionObject(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'function';
}
type WithTag = {tag?: unknown; unit?: unknown; nope?: unknown};
function hasTag(value: unknown): value is WithTag {
  return typeof value === 'function';
}

class Gauge<Reading> {
  declare static tag?: unknown;
  static unit: string = 'kPa';
  static note?: string;
  static limits: {high: number} = {high: 9};
  static describeKind(): string {
    return 'gauge ' + Gauge.unit;
  }
  reading: Reading;
  constructor(reading: Reading) {
    this.reading = reading;
  }
  show(): string {
    return 'gauge ' + JSON.stringify(this.reading);
  }
  kind(): string {
    return 'gauge';
  }
}
class Dial extends Gauge<number> {
  show(): string {
    return 'dial ' + this.reading + ' ' + this.kind();
  }
}
class Meter extends Gauge<number> {
  static override tag = 'metered';
  static override unit: string = 'bar';
  static scale: number = 2;
  show(): string {
    return 'meter ' + this.reading * Meter.scale;
  }
}
class Probe extends Gauge<{depth: number}> {
  static override tag = {name: 'probe'};
  show(): string {
    return 'probe ' + this.reading.depth;
  }
}

function tagOf(name: string, type: unknown): void {
  if (!hasTag(type)) {
    console.log(name, 'is not a function');
    return;
  }
  const tag = type.tag;
  console.log(name, typeof tag, tag === undefined ? 'undefined' : JSON.stringify(tag), 'tag' in type);
}
tagOf('Dial', Dial);
tagOf('Meter', Meter);
tagOf('Probe', Probe);
tagOf('Gauge', Gauge<number>);

function members(name: string, v: unknown): void {
  if (!isFunctionObject(v)) return;
  const limits = v['limits'];
  const describe = v['describeKind'];
  console.log(
    name,
    String(v['unit']),
    String(v['scale']),
    String(v['nope']),
    typeof v['note'],
    isObject(limits) ? limits['high'] : 'no limits',
    typeof describe === 'function' ? describe.call(v) : 'no method',
  );
  console.log(
    name,
    'unit' in v,
    Object.hasOwn(v, 'unit'),
    'note' in v,
    Object.hasOwn(v, 'note'),
    'nope' in v,
    Object.hasOwn(v, 'tag'),
    Object.keys(v).join(','),
  );
  console.log(
    name,
    JSON.stringify(Object.getOwnPropertyDescriptor(v, 'unit')),
    JSON.stringify(Object.getOwnPropertyDescriptor(v, 'note')),
    String(Object.getOwnPropertyDescriptor(v, 'tag') === undefined),
  );
}
members('Dial', Dial);
members('Meter', Meter);
members('Gauge', Gauge<number>);

// A name no class declares, and one declared for the type only, become own
// properties of the class they are written on.
function write(v: unknown): void {
  if (!isFunctionObject(v)) return;
  v['nope'] = 7;
  v['tag'] = 'set';
  v['note'] = 'noted';
  console.log(String(v['nope']), String(v['tag']), String(v['note']), Object.hasOwn(v, 'nope'), Object.hasOwn(v, 'tag'));
}
write(Dial);
tagOf('Meter', Meter);
console.log(Meter.tag, Meter.unit);

// The constructor an instance answers with carries the same members.
function fromInstance(made: unknown): void {
  if (!isObject(made)) return;
  const type = made['constructor'];
  if (hasTag(type)) console.log(typeof type.tag, String(type.unit), type === Meter);
}
fromInstance(new Meter(4));

// `show` is overridden by every class below Gauge, so no typed call reaches
// the method Gauge declares: replacing it through the dynamic prototype is
// visible exactly where JavaScript shows it.
function replaceShow(v: unknown): void {
  if (!isFunctionObject(v)) return;
  const prototype = v['prototype'];
  if (!isObject(prototype)) return;
  const before = prototype['show'];
  prototype['show'] = function (): string {
    return 'replaced';
  };
  const after = prototype['show'];
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'show');
  console.log(
    typeof before,
    before === after,
    typeof after === 'function' ? after.call(undefined) : 'no method',
    isObject(descriptor) && typeof descriptor['value'],
    isObject(descriptor) && descriptor['writable'],
    isObject(descriptor) && descriptor['enumerable'],
    Object.getOwnPropertyNames(prototype).join(','),
  );
}
replaceShow(Gauge<number>);
console.log(new Dial(3).show(), new Meter(4).show(), new Probe({depth: 8}).show());

// One class object per declaration: the base of every subclass is the same
// value, whichever instantiation it extends.
function sameBase(a: unknown, b: unknown, c: unknown): void {
  const seen = new Map<unknown, string>();
  seen.set(Object.getPrototypeOf(a), 'base');
  console.log(
    Object.getPrototypeOf(a) === Object.getPrototypeOf(b),
    Object.getPrototypeOf(b) === c,
    seen.get(Object.getPrototypeOf(b)),
    seen.has(c),
    a === b,
  );
}
sameBase(Dial, Probe, Gauge<number>);
