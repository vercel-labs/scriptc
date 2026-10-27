// Symbol-keyed properties read and written many times: on plain objects, on
// prototypes and class instances, with Symbol.for symbols, and with symbols
// created in a loop (each a distinct key, even after earlier ones are
// unreachable), plus the same symbol converted to a checked value repeatedly.
const tag = Symbol("tag");
const shared = Symbol.for("shared");
const proto = { [tag]: "from proto" };
const child = Object.create(proto);
child[shared] = 0;
for (let i = 0; i < 1000; i++) child[shared] += i;
console.log(child[tag], child[shared], Object.getOwnPropertySymbols(child).length);

const count = Symbol("count");
class Counter {
  constructor() {
    this[count] = 0;
  }
  bump() {
    this[count]++;
    return this;
  }
  get count() {
    return this[count];
  }
}
const c = new Counter();
for (let i = 0; i < 500; i++) c.bump();
console.log(c.count, c[count], count.toString());

const keys = [];
const holder = {};
for (let i = 0; i < 300; i++) {
  const key = Symbol(`k${i}`);
  holder[key] = i;
  if (i % 100 === 0) keys.push(key);
}
let sum = 0;
for (const key of Object.getOwnPropertySymbols(holder)) sum += holder[key];
console.log(sum, keys.map((k) => holder[k]).join(), keys[1].description);

// Symbols that become unreachable between rounds: a new symbol never reads
// a property stored under an earlier one.
const scratch = {};
let stale = 0;
for (let round = 0; round < 200; round++) {
  const key = Symbol("round");
  if (scratch[key] !== undefined) stale++;
  scratch[key] = round;
}
console.log(stale, Object.getOwnPropertySymbols(scratch).length);

// A symbol stored, deleted and dropped each round, so its storage can be
// reused by the next round's symbol: the new symbol still reads nothing.
const persist = {};
let reused = 0;
for (let round = 0; round < 200; round++) {
  const key = Symbol("dropped");
  if (key in persist) reused++;
  persist[key] = round;
  delete persist[key];
}
console.log(reused, Object.getOwnPropertySymbols(persist).length);

const viaFor = {};
for (let i = 0; i < 10; i++) viaFor[Symbol.for("same")] = i;
console.log(viaFor[Symbol.for("same")], Object.getOwnPropertySymbols(viaFor).length);
console.log(Symbol.for("same") === Symbol.for("same"), Symbol("x") === Symbol("x"), tag === tag);
const boxes = [tag, tag, shared];
console.log(boxes[0] === boxes[1], boxes.indexOf(shared), new Set(boxes).size);
