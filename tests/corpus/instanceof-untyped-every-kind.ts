// `value instanceof Target` for a value held as `unknown`: built-in classes and every form of
// program class (plain, with a base, generic, below a generic class, abstract, implementing an
// interface, extending Error), asked of every runtime kind of value. One line per cell. Every
// target is a constructor, so the question never throws: a value that is not an instance
// answers false.
class Plain {
  n: number = 1;
}
class Base {
  protected isBase(): boolean {
    return true;
  }
}
class Leaf extends Base {
  n: number = 2;
}
class Box<T> {
  item: T;
  constructor(item: T) {
    this.item = item;
  }
}
class GBase {
  protected isGBase(): boolean {
    return true;
  }
}
class GNode<Form = unknown> extends GBase {
  form: Form | null = null;
  tag(): string {
    return 'node';
  }
}
class GLeaf extends GNode {
  override tag(): string {
    return 'leaf';
  }
}
abstract class Shape {
  abstract area(): number;
}
class Circle extends Shape {
  area(): number {
    return 3;
  }
}
interface Face {
  face(): string;
}
class Impl implements Face {
  face(): string {
    return 'impl';
  }
}
class AppError extends Error {
  code: number = 7;
}

function* gen(): Generator<number> {
  yield 1;
}
async function* agen(): AsyncGenerator<number> {
  yield 1;
}
function declared(): number {
  return 1;
}

const values: Array<[string, unknown]> = [
  ['number', 1],
  ['string', 's'],
  ['boolean', true],
  ['bigint', 10n],
  ['symbol', Symbol('s')],
  ['null', null],
  ['undefined', undefined],
  ['plain object', {a: 1}],
  ['null prototype', Object.create(null)],
  ['array', [1, 2]],
  ['uint8 array', new Uint8Array(4)],
  ['float64 array', new Float64Array(2)],
  ['array buffer', new ArrayBuffer(4)],
  ['data view', new DataView(new ArrayBuffer(4))],
  ['map', new Map<string, number>()],
  ['set', new Set<number>()],
  ['weak map', new WeakMap<object, number>()],
  ['weak set', new WeakSet<object>()],
  ['date', new Date(0)],
  ['regexp', /a/],
  ['error', new Error('e')],
  ['type error', new TypeError('e')],
  ['range error', new RangeError('e')],
  ['app error', new AppError('e')],
  ['promise', Promise.resolve(1)],
  ['arrow', (): number => 1],
  ['function', declared],
  ['class value', Base],
  ['generator', gen()],
  ['async generator', agen()],
  ['map iterator', new Map<string, number>().entries()],
  ['set iterator', new Set<number>().values()],
  ['array iterator', [1, 2].values()],
  ['url', new URL('https://example.com/')],
  ['url search params', new URLSearchParams('a=1')],
  ['text encoder', new TextEncoder()],
  ['buffer', Buffer.from('ab')],
  ['a Plain', new Plain()],
  ['a Base', new Base()],
  ['a Leaf', new Leaf()],
  ['a Box', new Box<number>(1)],
  ['a GBase', new GBase()],
  ['a GNode', new GNode<string>()],
  ['a GLeaf', new GLeaf()],
  ['a Circle', new Circle()],
  ['an Impl', new Impl()],
];

const targets: Array<[string, (v: unknown) => boolean]> = [
  ['Error', (v: unknown): boolean => v instanceof Error],
  ['TypeError', (v: unknown): boolean => v instanceof TypeError],
  ['Array', (v: unknown): boolean => v instanceof Array],
  ['Map', (v: unknown): boolean => v instanceof Map],
  ['Set', (v: unknown): boolean => v instanceof Set],
  ['Promise', (v: unknown): boolean => v instanceof Promise],
  ['Date', (v: unknown): boolean => v instanceof Date],
  ['RegExp', (v: unknown): boolean => v instanceof RegExp],
  ['Uint8Array', (v: unknown): boolean => v instanceof Uint8Array],
  ['Plain', (v: unknown): boolean => v instanceof Plain],
  ['Base', (v: unknown): boolean => v instanceof Base],
  ['Leaf', (v: unknown): boolean => v instanceof Leaf],
  ['Box', (v: unknown): boolean => v instanceof Box],
  ['GBase', (v: unknown): boolean => v instanceof GBase],
  ['GNode', (v: unknown): boolean => v instanceof GNode],
  ['GLeaf', (v: unknown): boolean => v instanceof GLeaf],
  ['Shape', (v: unknown): boolean => v instanceof Shape],
  ['Circle', (v: unknown): boolean => v instanceof Circle],
  ['Impl', (v: unknown): boolean => v instanceof Impl],
  ['AppError', (v: unknown): boolean => v instanceof AppError],
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
