// 2717 Set<Promise<void>> & Set<object> pointer identity (LIST 4.2)
const p1 = Promise.resolve();
const p2 = Promise.resolve();
const s = new Set<Promise<void>>();
s.add(p1); s.add(p1);
console.log(s.size, s.has(p1), s.has(p2));
s.delete(p1);
console.log(s.size, s.has(p1));

const o1: object = { id: 1 }, o2: object = { id: 1 };
const so = new Set<object>();
so.add(o1); so.add(o2);
console.log(so.size, so.has(o1), so.has(o2), so.has({ id: 1 }));
console.log([...so].length);
