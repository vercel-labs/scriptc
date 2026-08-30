const obj = { a: 1, b: 2, c: 3 };
const entries = Object.entries(obj);
for (const [k, v] of entries) {
  console.log(k, v);
}

const vals = Object.values(obj);
console.log(vals.join(","));

const keys = Object.keys(obj);
console.log(keys.join(","));
