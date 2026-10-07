const values = [5, -5, 0, -0, 4, -4, 7.25, -7.25, 9007199254740991, -9007199254740991, 9007199254740992, 9007199254740994, 1e300, -1e300, Infinity, -Infinity, NaN, 0.5, 3, -3, 2, 1e-300];
const divisors = [3, -3, 2, -2, 0, -0, 1, 7, 1.5, Infinity, -Infinity, NaN, 9007199254740993, 1e-300, 1000003];
const out: string[] = [];
for (const a of values)
  for (const b of divisors) {
    const r = a % b;
    out.push(Object.is(r, -0) ? "-0" : String(r));
  }
let acc = 0;
for (let i = 0; i < 2000; i++) acc = (acc * 31 + i) % 1000003;
console.log(out.join(","), acc);
