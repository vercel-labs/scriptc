type Value = ReadonlyMap<string, number> | ReadonlySet<string> | string | number | null | undefined;
let evaluations = 0;
function once(value: Value): Value { evaluations++; return value; }
function inspect(value: Value): string {
  if (once(value) instanceof Map) console.log('map-test');
  if (value instanceof Map) {
    let sum = 0;
    for (const [key, entry] of value) { sum += entry; console.log(key); }
    console.log(value.has('first'), value.get('first'), value.get('missing'));
    return 'map:' + value.size + ':' + sum;
  }
  if (value instanceof Set) {
    let text = '';
    for (const entry of value) text += entry;
    return 'set:' + text;
  }
  if (typeof value === 'string') return 'text:' + value;
  if (typeof value === 'number') return String(value);
  return value === null ? 'null' : 'undefined';
}
const map = new Map<string, number>([['first', 1], ['second', 2]]);
const set = new Set<string>(['a', 'b']);
console.log(inspect(map), inspect(set), inspect('hello'), inspect(7), inspect(null), inspect(undefined));
console.log(evaluations);
function update(value: Map<string, number> | string): void {
  if (value instanceof Map) value.set('third', 3);
}
function same(value: Value): boolean { return value === map; }
update(map);
console.log(map.get('third'), same(map), same(set));

function label(value: Map<string, number> | { text: string }): string {
  return value instanceof Map ? String(value.get('first')) : value.text;
}
console.log(label(map), label({ text: 'record' }));

function* collectionSteps(): Generator<Map<string, number>, string, unknown> {
  yield map;
  return 'done';
}
const steps = collectionSteps();
const first = steps.next();
console.log(first.done, first.value instanceof Map, first.value === map);
const last = steps.next();
console.log(last.done, last.value);
