// Object/array literals in `any` slots: property reads/writes, computed
// keys, and method calls go through the checked-dynamic value, including a
// member read on a fresh typed call result (`s.split(" ").length`).
const o: any = { a: 1, b: "x", nested: { deep: true } };
o.a = o.a + 10;
o["c"] = 2.5;
console.log(`${o.a} ${o.b} ${o.c}`, `${o.nested.deep}`, typeof o);
const arr: any = [1, "two", true];
arr[3] = o.a;
console.log(`${arr.length}`, `${arr[1]}`, `${arr[3]}`);
console.log(`${arr.join("|")}`);
const s: any = "hello world";
console.log(`${s.toUpperCase()}`, `${s.split(" ").length}`, `${s.charAt(4)}`);
const num: any = 3.14159;
console.log(`${num.toFixed(2)}`);
