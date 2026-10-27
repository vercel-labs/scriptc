// Member assignments used as values: the receiver, the key and the value are
// evaluated in order, and the expression yields the assigned value.
const log = [];
const holder = { get inner() { log.push("receiver"); return this._inner; }, _inner: {} };
function value(v) { log.push("value"); return v; }
function key(k) { log.push("key"); return k; }
const r = holder.inner[key("k")] = value(5);
console.log(r, log.join(","), holder._inner.k);
const store = JSON.parse('{"a":{},"b":{}}');
const t = { id: "x" };
const out = store["a"][t.id] = store.b[t.id] = t;
console.log(out === t, JSON.stringify(store));
let n;
const arr = [0, 0, 0];
n = arr[1] = arr[2] = 7;
console.log(n, arr);
function Counter() { this.count = 0; }
Counter.prototype.bump = function () { return (this.count = this.count + 1); };
const c = new Counter();
console.log(c.bump(), c.bump(), c.count);
