export {};
// An element read of an untyped value by a number (`values[j]` where
// `values` is untyped), over every kind of receiver and every form of
// index: elements, holes, a length that moved, named properties whose names
// spell numbers, and indexes that are no array index (negative, -0, a
// fraction, NaN, the infinities, and integers from 2^32 to past 2^63).
const out: string[] = [];
function text(v: unknown): string {
  if (typeof v === 'function') return 'function';
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch (e) {
    return 'throws ' + String(e);
  }
}
const indexes: number[] = [
  0, 1, 2, 3, 10, -1, -0, 1.5, NaN, Infinity, -Infinity, 4294967295, 4294967296, 9007199254740992,
  -9223372036854775808, 1e21, 1.7976931348623157e308,
];
function readAll(tag: string, v: unknown): void {
  let line = tag + ':';
  for (let i = 0; i < indexes.length; i++) {
    const j = indexes[i];
    try {
      const got: unknown = (v as any)[j];
      line += ' ' + String(j) + '=' + text(got);
    } catch (e) {
      line += ' ' + String(j) + '=' + (e instanceof Error ? e.name + ' ' + e.message : String(e));
    }
  }
  out.push(line);
}
function sum(values: Array<unknown>): string {
  // the loop shape of a walk over a parsed list
  let acc = '';
  for (let j = 0; j < values.length + 1; j++) {
    const v = values[j];
    acc += typeof v + (v === undefined ? '!' : '') + ',';
  }
  return acc;
}
class Row {
  0 = 'zero field';
  name = 'row';
}
class List extends Array<number> {
  extra = 'x';
}
const parsed: unknown = JSON.parse('[1,"two",null,{"a":1},[5]]');
const empty: unknown = JSON.parse('[]');
const holes: any = JSON.parse('[1,2,3]');
holes[10] = 'ten';
const shortened: any = JSON.parse('[1,2,3,4]');
shortened.length = 2;
const grown: any = JSON.parse('[1]');
grown.push('pushed');
grown.push({ deep: true });
const popped: any = JSON.parse('[1,2,3]');
popped.pop();
const deleted: any = JSON.parse('[1,2,3]');
delete deleted[1];
const withProps: any = JSON.parse('[7,8]');
withProps.label = 'named';
withProps['1.5'] = 'fraction';
withProps['-1'] = 'minus one';
const frozen: unknown = Object.freeze(JSON.parse('[1,2]'));
const typedNumbers: unknown = [10, 20, 30];
const typedStrings: unknown = ['a', 'b'];
const typedRows: unknown = [new Row(), new Row()];
const bytes: unknown = new Uint8Array([9, 8, 7]);
const arrayLike: unknown = JSON.parse('{"0":"zero","1":"one","length":2,"1.5":"f","-1":"neg"}');
const row: unknown = new Row();
const list: unknown = new List();
(list as List).push(4, 5);
const word: unknown = 'héllo';
const five: unknown = 5;
const fn: unknown = function f(): void {};
const nested: unknown = JSON.parse('[[1,2],[3,[4,5]]]');

const values: [string, unknown][] = [
  ['parsed', parsed],
  ['empty', empty],
  ['holes', holes],
  ['shortened', shortened],
  ['grown', grown],
  ['popped', popped],
  ['deleted', deleted],
  ['withProps', withProps],
  ['frozen', frozen],
  ['typedNumbers', typedNumbers],
  ['typedStrings', typedStrings],
  ['typedRows', typedRows],
  ['bytes', bytes],
  ['arrayLike', arrayLike],
  ['row', row],
  ['list', list],
  ['word', word],
  ['five', five],
  ['fn', fn],
  ['nested', nested],
  ['null', null],
  ['undefined', undefined],
];
for (const [tag, v] of values) readAll(tag, v);
out.push('sum parsed: ' + sum(parsed as Array<unknown>));
out.push('sum holes: ' + sum(holes as Array<unknown>));
out.push('sum deleted: ' + sum(deleted as Array<unknown>));
out.push('sum typed: ' + sum(typedNumbers as Array<unknown>));
out.push('sum empty: ' + sum(empty as Array<unknown>));
// an element read keeps the element alive after the list changes
const live: any = JSON.parse('[{"k":1},{"k":2}]');
const first: unknown = live[0];
live.length = 0;
live.push('new');
out.push('kept: ' + text(first) + ' now: ' + text(live[0]) + ' ' + text(live[1]));
// the same element read twice is the same object
const same: any = JSON.parse('[{"k":1}]');
out.push('identity: ' + String(same[0] === same[0]));
same[0].k = 2;
out.push('written through: ' + text(same[0]));
// 2^63, where a conversion to a 64-bit integer saturates, read from arrays.
const far: number[] = [9223372036854775807, 9223372036854775808];
for (let i = 0; i < far.length; i++) {
  const j = far[i];
  out.push(
    'far ' + String(j) + ': ' + text((parsed as any)[j]) + ' ' + text(holes[j]) + ' ' + text(withProps[j]) + ' ' + text((typedNumbers as any)[j]),
  );
}
console.log(out.join('\n'));
