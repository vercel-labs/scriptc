export {};
// A typed array held in an untyped value, asked by index. A reference to
// an array the program made typed (a typed literal, the result of `map`,
// `filter` or `slice`, a tuple, a read-only array) answers an element read
// by a number from the array itself: the index never becomes a string.
// Every element kind and array kind is read by numbers that are indexes
// and numbers that are not (negative, -0, a fraction, NaN, 2^32 - 1 and
// past it), by a counter, by strings that spell an index and strings that
// do not, with `at`, `for…of`, `in` and `length`; object elements keep
// their identity; writes through the untyped value are the typed array's
// own, and the typed side's writes are seen through the untyped value.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
class Other {
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
}
type Rec = {name: string; n: number};
class Box {
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
  }
}
function childrenOf(made: Box): unknown {
  const config: any = made.config;
  return config.children;
}
const escaped: Array<unknown> = [new Point(0, 0), new Other('o')];

function show(x: unknown): string {
  if (x === undefined) return 'undefined';
  if (x === null) return 'null';
  if (typeof x === 'number') return Object.is(x, -0) ? '-0' : String(x);
  if (typeof x === 'boolean') return String(x);
  if (typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'function') return 'function';
  if (x instanceof Point) return 'Point(' + x.x + ',' + x.y + ')';
  if (Array.isArray(x)) {
    let out = '[';
    for (let i = 0; i < x.length; i++) out += (i > 0 ? ',' : '') + show(x[i]);
    return out + ']';
  }
  return JSON.stringify(x);
}

const NUMBERS: Array<number> = [0, 1, 2, 3, -1, 1.5, -0, NaN, 4294967294, 4294967295, 4294967296, 9007199254740992, Infinity];
const NAMES: Array<string> = ['0', '1', '01', '1.0', '+1', ' 1', '1e0', '-0', 'length', 'missing', ''];

function probe(label: string, v: unknown): void {
  const a: any = v;
  let line = label + ' num:';
  for (let k = 0; k < NUMBERS.length; k++) {
    const i: number = NUMBERS[k];
    line += ' ' + show(a[i]);
  }
  console.log(line);
  line = label + ' counter:';
  for (let i = 0; i < 4; i++) line += ' ' + show(a[i]);
  const n: number = a.length;
  for (let i = 0; i < n; i++) line += ' ' + show(a[i]);
  console.log(line);
  line = label + ' str:';
  for (let k = 0; k < NAMES.length; k++) line += ' ' + show(a[NAMES[k]]);
  console.log(line);
  line = label + ' at:';
  for (let i = -2; i < 4; i++) line += ' ' + show(a.at(i));
  console.log(line);
  line = label + ' of:';
  for (const item of a) line += ' ' + show(item);
  console.log(line);
  line = label + ' in:';
  for (let k = 0; k < 6; k++) {
    const i: number = NUMBERS[k];
    line += ' ' + (i in a);
  }
  for (let k = 0; k < NAMES.length; k++) line += ' ' + (NAMES[k] in a);
  console.log(line);
  console.log(label + ' length: ' + show(a.length) + ' same: ' + (a[0] === a[0]) + ' ' + (a[1] === a[1]) + ' ' + (a[0] === a[1]) + ' isArray: ' + Array.isArray(v));
}

function put(v: unknown, i: number, x: unknown): void {
  (v as any)[i] = x;
}

function cells(): void {
  const numbers: Array<number> = [10, 20, 30];
  const strings: Array<string> = ['a', 'b', 'c'];
  const flags: Array<boolean> = [true, false, true];
  const points: Array<Point> = [new Point(1, 2), new Point(3, 4), new Point(5, 6)];
  const records: Array<Rec> = [{name: 'r0', n: 0}, {name: 'r1', n: 1}, {name: 'r2', n: 2}];
  const mixed: Array<number | string> = [1, 'two', 3];
  const nested: Array<Array<number>> = [[1, 2], [3], []];
  const optional: Array<number | undefined> = [1, undefined, 3];
  const frozen: ReadonlyArray<number> = [7, 8, 9];
  const pair: [number, string, boolean] = [1, 'one', true];
  const sparse: Array<number> = new Array<number>(3);
  sparse[1] = 7;
  const bytes = new Uint8Array([1, 2, 3]);
  const loose: Array<unknown> = [1, 'a', new Point(9, 9)];

  probe('lit-number', childrenOf(new Box({children: numbers})));
  probe('lit-string', childrenOf(new Box({children: strings})));
  probe('lit-boolean', childrenOf(new Box({children: flags})));
  probe('lit-point', childrenOf(new Box({children: points})));
  probe('lit-record', childrenOf(new Box({children: records})));
  probe('lit-union', childrenOf(new Box({children: mixed})));
  probe('lit-nested', childrenOf(new Box({children: nested})));
  probe('lit-optional', childrenOf(new Box({children: optional})));
  probe('map-number', childrenOf(new Box({children: numbers.map(x => x * 2)})));
  probe('map-point', childrenOf(new Box({children: numbers.map(x => new Point(x, 1))})));
  probe('filter-point', childrenOf(new Box({children: points.filter(p => p.x > 1)})));
  probe('slice-string', childrenOf(new Box({children: strings.slice(1)})));
  probe('readonly', childrenOf(new Box({children: frozen})));
  probe('tuple', childrenOf(new Box({children: pair})));
  probe('sparse', childrenOf(new Box({children: sparse})));
  probe('bytes', childrenOf(new Box({children: bytes})));
  probe('untyped', childrenOf(new Box({children: loose})));
  const direct: unknown = numbers.map(x => x + 1);
  probe('direct', direct);
  probe('empty', childrenOf(new Box({children: numbers.filter(x => x > 99)})));

  // Writes through the untyped value are the typed array's own.
  const target: Array<number> = [1, 2, 3];
  const held = childrenOf(new Box({children: target}));
  put(held, 1, 20);
  put(held, 3, 40);
  console.log('write number: ' + show(held) + ' typed: ' + target.join(',') + ' ' + target.length);
  const made: Array<Point> = numbers.map(x => new Point(x, 0));
  const heldPoints = childrenOf(new Box({children: made}));
  const fresh = new Point(7, 7);
  put(heldPoints, 0, fresh);
  console.log('write point: ' + show(heldPoints) + ' typed: ' + made[0].x + ' ' + ((heldPoints as any)[0] === fresh) + ' ' + (made[0] === fresh));
  const words: Array<string> = strings.map(s => s + s);
  const heldWords = childrenOf(new Box({children: words}));
  for (let i = 0; i < 3; i++) put(heldWords, i, 'w' + i);
  console.log('write string: ' + show(heldWords) + ' typed: ' + words.join(','));
  // The typed side's writes are seen through the untyped value.
  target[0] = 100;
  target.push(5);
  console.log('typed write: ' + show((held as any)[0]) + ' ' + show((held as any)[4]) + ' ' + show((held as any).length));
}

cells();
console.log('classes that reach untyped values: ' + escaped.length);
