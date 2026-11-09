// `value instanceof Target` in its other forms: the value narrowed to `object` first, the value
// thrown and caught, the class taken from a variable, the value held as a union. Every runtime
// kind of value answers; none throws.
class Base {
  protected isBase(): boolean {
    return true;
  }
}
class Leaf extends Base {
  n: number = 2;
}
class GNode<Form = unknown> extends Base {
  form: Form | null = null;
}
class GLeaf extends GNode {
  m: number = 3;
}
class AppError extends Error {
  code: number = 7;
}

function* gen(): Generator<number> {
  yield 1;
}

const values: Array<[string, unknown]> = [
  ['number', 1],
  ['string', 's'],
  ['null', null],
  ['plain object', {a: 1}],
  ['array', [1, 2]],
  ['uint8 array', new Uint8Array(4)],
  ['array buffer', new ArrayBuffer(4)],
  ['data view', new DataView(new ArrayBuffer(4))],
  ['map', new Map<string, number>()],
  ['date', new Date(0)],
  ['error', new Error('e')],
  ['app error', new AppError('e')],
  ['promise', Promise.resolve(1)],
  ['arrow', (): number => 1],
  ['generator', gen()],
  ['map iterator', new Map<string, number>().entries()],
  ['array iterator', [1, 2].values()],
  ['url', new URL('https://example.com/')],
  ['buffer', Buffer.from('ab')],
  ['a Base', new Base()],
  ['a Leaf', new Leaf()],
  ['a GNode', new GNode()],
  ['a GLeaf', new GLeaf()],
];

function isObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null;
}
function caught(v: unknown, ask: (x: unknown) => boolean): boolean {
  try {
    throw v;
  } catch (x) {
    return ask(x);
  }
}
function caughtBase(v: unknown): boolean {
  try {
    throw v;
  } catch (x) {
    return x instanceof Base;
  }
}
function caughtError(v: unknown): boolean {
  try {
    throw v;
  } catch (x) {
    return x instanceof Error;
  }
}
function caughtGNode(v: unknown): boolean {
  try {
    throw v;
  } catch (x) {
    return x instanceof GNode;
  }
}
function byClass(v: unknown, K: typeof Base): boolean {
  return v instanceof K;
}
function held(v: Leaf | GLeaf | AppError | Array<number> | string | null): string {
  return (v instanceof Base) + ' ' + (v instanceof Leaf) + ' ' + (v instanceof GNode) + ' ' + (v instanceof Error);
}

const targets: Array<[string, (v: unknown) => boolean]> = [
  ['object Base', (v: unknown): boolean => isObject(v) && v instanceof Base],
  ['object Leaf', (v: unknown): boolean => isObject(v) && v instanceof Leaf],
  ['object GNode', (v: unknown): boolean => isObject(v) && v instanceof GNode],
  ['object Error', (v: unknown): boolean => isObject(v) && v instanceof Error],
  ['object Map', (v: unknown): boolean => isObject(v) && v instanceof Map],
  ['caught Base', caughtBase],
  ['caught GNode', caughtGNode],
  ['caught Error', caughtError],
  ['caught, then Base', (v: unknown): boolean => caught(v, (x: unknown): boolean => x instanceof Base)],
  ['class Base', (v: unknown): boolean => byClass(v, Base)],
];

for (const [target, ask] of targets) {
  for (const [label, value] of values) {
    let line = target + ' <- ' + label + ': ';
    try {
      line += ask(value);
    } catch (x) {
      line += 'THROWS ' + (x instanceof Error ? x.message : 'a value');
    }
    console.log(line);
  }
}
console.log('held a Leaf: ' + held(new Leaf()));
console.log('held a GLeaf: ' + held(new GLeaf()));
console.log('held an app error: ' + held(new AppError('e')));
console.log('held an array: ' + held([1, 2]));
console.log('held a string: ' + held('s'));
console.log('held null: ' + held(null));
