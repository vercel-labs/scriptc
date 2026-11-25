// A program that keeps its own state on the global object under symbol
// keys (Reflect.set, Object.defineProperty, an assignment) and calls
// built-ins through the global object. A symbol names no built-in, so
// those writes leave `globalThis.structuredClone(…)` and the others the
// built-ins they are.
const VISITS = Symbol.for('garden.visits');
const BEDS = Symbol.for('garden.beds');
const GATE = Symbol('gate');

Reflect.set(globalThis, VISITS, 0);
Object.defineProperty(globalThis, BEDS, { value: ['herbs', 'beans'], writable: true });
globalThis[GATE] = 'open';

function visit(bed) {
  Reflect.set(globalThis, VISITS, Reflect.get(globalThis, VISITS) + 1);
  return globalThis[BEDS].includes(bed);
}

const plan = { beds: globalThis[BEDS], rows: [3, 4] };
const copy = globalThis.structuredClone(plan);
copy.rows.push(5);
console.log(visit('herbs'), visit('roses'), globalThis[VISITS], globalThis[GATE]);
console.log(JSON.stringify(plan), JSON.stringify(copy));

const where = new globalThis.URL('https://garden.example/beds/herbs?row=3');
console.log(where.pathname, where.searchParams.get('row'), global.encodeURIComponent('sweet pea'));

globalThis.queueMicrotask(() => console.log('watered', Reflect.get(globalThis, VISITS)));
global.setTimeout(() => console.log('closed', Reflect.deleteProperty(globalThis, GATE), globalThis[GATE]), 1);
console.log('planted');
