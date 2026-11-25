// util.format over format strings a JavaScript source builds at run time:
// the substitution loop, the checked-dynamic conversions and the rest-args
// tail. A record's own toString answers %s (String(arg)) and the same
// record inspects in the tail; arrays, nested objects and typed arrays
// follow the depth-0 rule under %s and the options' depth in the tail; %d,
// %i and %f read through Number and %j serializes with JSON.stringify,
// including the BigInt TypeError. Node is the oracle.
import { format, formatWithOptions } from 'node:util';

const specifier = ['%', 's'].join('');
const specifiers = ['%', 's %', 'O'].join('');
const record = { n: 1, toString() { return `rec:${this.n}`; } };
const plain = { a: 1, b: 'x' };
const nested = { a: { b: { c: 1 } } };
const date = new Date(0);
const map = new Map([['a', 1]]);
const set = new Set([1, 2]);
const regexp = /a/g;
const bytes = new Uint8Array([1, 2, 3]);
const sym = Symbol('sym');

console.log(format(specifier, 'str'));
console.log(format(specifier, 42));
console.log(format(specifier, 10n));
console.log(format(specifier, sym));
console.log(format(specifier, null), format(specifier, undefined));
console.log(format(specifier, true));
console.log(format(specifier, record));
console.log(format(specifier, plain));
console.log(format(specifier, nested));
console.log(format(specifier, [1, [2, [3]]]));
console.log(format(specifier, date));
console.log(format(specifier, map));
console.log(format(specifier, set));
console.log(format(specifier, regexp));
console.log(format(specifier, bytes));
console.log(format(specifier, new Float64Array([1.5, 2])));
console.log(format(specifier, Buffer.from('hi')));
console.log(format(specifier, new DataView(new ArrayBuffer(2))));
const link = new URL('http://example.com/p?x=1&y=2#h');
console.log(format(specifier, link));
console.log(format(specifier, link.searchParams));
console.log(format('tail', link, link.searchParams));
console.log(format(specifiers, plain, plain));

console.log(format('tail', record, plain, nested, [1, [2]], date, bytes, sym, 10n));
console.log(format('%s tail', record, plain, record));
console.log(format('only %d tail', 5, 6, 7));
console.log(format('%s %s', 'a', 'b', 'c', 'd'));
console.log(format('100%% %c %j', 'style', plain));
console.log(format('%d %i %f', '3.9', '4.9', '1.5e2'));
console.log(format('%d', { valueOf() { return 7; } }));
console.log(format('%i', { valueOf() { return 3.9; } }));
// ToNumber / parseInt / parseFloat over the values that are not numbers:
// collections read "[object Map]", a typed array joins its elements, a
// symbol answers NaN in all three.
console.log(format('%d', map), format('%i', set), format('%f', bytes));
console.log(format('%d|%i|%f', bytes, bytes, bytes));
console.log(format('%d|%i|%f', sym, sym, sym));
console.log(format('%d|%i|%f', -0, -0, -0));
console.log(format('%f', 'abc'), format('%f', Infinity), format('%d', 'abc'));
console.log(format('%j', plain), format('%j', [1, 'two']), format('%j', undefined));
try {
  console.log(format('%j', 5n));
} catch (e) {
  console.log('throw', e.name, e.message);
}
console.log(format('%O', nested));
console.log(format('%o', nested));

console.log(formatWithOptions({ depth: 0 }, specifiers, plain, plain));
console.log(formatWithOptions({ depth: 1 }, specifiers, nested, nested));
console.log(formatWithOptions({ depth: null }, '%O', nested));
console.log(formatWithOptions({ breakLength: 8 }, '%O', [1, 2, 3, 4]));
console.log(formatWithOptions({ maxArrayLength: 2 }, '%O', [1, 2, 3, 4]));
console.log(formatWithOptions({ maxStringLength: 2 }, '%O', 'abcdef'));
console.log(formatWithOptions({ sorted: true }, '%O', { b: 1, a: 2 }));
console.log(formatWithOptions({ compact: 0 }, '%O', { a: [1, 2], b: [3, 4] }));
console.log(formatWithOptions({}, '%s', record));
