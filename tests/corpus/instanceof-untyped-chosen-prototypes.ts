// `value instanceof Target` for objects whose prototype the program chose (the chain a class
// test walks) and for a Proxy, which has its target's prototype.
class Base {
  protected isBase(): boolean {
    return true;
  }
}
class Leaf extends Base {
  n: number = 2;
}
class Other {
  o: number = 3;
}
class GNode<Form = unknown> extends Base {
  form: Form | null = null;
}

const values: Array<[string, unknown]> = [
  ['created from an object', Object.create({a: 1})],
  ['created from a created one', Object.create(Object.create({a: 1}))],
  ['set to an object', Object.setPrototypeOf({a: 1}, {b: 2})],
  ['created from null', Object.create(null)],
  ['proxy of an object', new Proxy({a: 1}, {})],
  ['proxy of a created one', new Proxy(Object.create({a: 1}), {})],
  ['a Leaf', new Leaf()],
  ['an Other', new Other()],
];

const targets: Array<[string, (v: unknown) => boolean]> = [
  ['Error', (v: unknown): boolean => v instanceof Error],
  ['Array', (v: unknown): boolean => v instanceof Array],
  ['Map', (v: unknown): boolean => v instanceof Map],
  ['Date', (v: unknown): boolean => v instanceof Date],
  ['Base', (v: unknown): boolean => v instanceof Base],
  ['Leaf', (v: unknown): boolean => v instanceof Leaf],
  ['Other', (v: unknown): boolean => v instanceof Other],
  ['GNode', (v: unknown): boolean => v instanceof GNode],
];

// Values whose chain the program set to a class's own prototype, read off an instance: these are
// instances of the class and of its ancestors, whatever kind of value they are.
interface Point {
  x: number;
  y: number;
}

function hold(v: unknown): unknown {
  return v;
}

const leafPrototype: unknown = Object.getPrototypeOf(hold(new Leaf()));
const point: Point = {x: 1, y: 2};
const list: number[] = [1, 2, 3];
const pair: [number, string] = [1, 'a'];

const chosen: Array<[string, unknown]> = [
  ['created from the prototype of a Leaf', Object.create(leafPrototype as object)],
  ['created from one created from it', Object.create(Object.create(leafPrototype as object))],
  ['an object set to it', Object.setPrototypeOf({a: 1}, leafPrototype as object)],
  ['an array set to it', Object.setPrototypeOf([1, 2], leafPrototype as object)],
  ['a proxy of one created from it', new Proxy(Object.create(leafPrototype as object), {})],
  ['a record held untyped, set to it', Object.setPrototypeOf(hold(point) as object, leafPrototype as object)],
  ['an array held untyped, set to it', Object.setPrototypeOf(hold(list) as object, leafPrototype as object)],
  ['a tuple held untyped, set to it', Object.setPrototypeOf(hold(pair) as object, leafPrototype as object)],
];

function report(target: string, ask: (v: unknown) => boolean, label: string, value: unknown): void {
  let line = target + ' <- ' + label + ': ';
  try {
    line += ask(value);
  } catch (x) {
    line += 'THROWS ' + (x instanceof Error ? x.message : 'a value');
  }
  console.log(line);
}

for (const [target, ask] of targets) {
  for (const [label, value] of values) report(target, ask, label, value);
}
// The chosen chains are asked of the program's classes (the last four targets).
for (const [target, ask] of targets.slice(4)) {
  for (const [label, value] of chosen) report(target, ask, label, value);
}
