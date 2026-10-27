// Tuples that are only destructured or indexed: number and string
// elements, producer functions returning fresh tuples, literals passed to
// functions that only read their elements, and tuples that escape into
// arrays, closures, identity comparisons and printing.
function divmod(a: number, b: number): [number, number] {
  return [Math.floor(a / b), a % b];
}
const names = ["a", "bb", "ccc"];
function entry(i: number): [string, number] {
  return [names[i % 3]! + i, i];
}
function flip(p: [string, number]): [number, string] {
  return [p[1] * 2, p[0].toUpperCase()];
}
function area(r: [number, number]): number {
  return r[0] * r[1];
}
function risky(i: number): [string, string] {
  if (i % 4 === 2) throw new Error("risky " + i);
  return ["r" + i, String(i * i)];
}
const kept: [string, number][] = [];

let acc = 0;
let log = "";
for (let i = 0; i < 10; i++) {
  const [q, r] = divmod(i * 13, 7);
  acc += q + r;
  const [k, v] = entry(i);
  acc += k.length + v;
  const pair: [number, number] = [i, i + 1];
  acc += pair[0] * pair[1] + area([i, 2]) + area(pair);
  const [n, s] = flip(entry(i + 1));
  log += s + n;
  try {
    const [x, y] = risky(i);
    log += x + y.length;
  } catch (e) {
    log += "!";
  }
  if (i % 3 === 0) kept.push(entry(i));
}
console.log(acc, log);
console.log(kept.map(([name, i]) => name + "=" + i).join(" "));

let [left, right] = ["l", "r"];
for (let i = 0; i < 3; i++) [left, right] = [right, left + i];
console.log(left, right);

const t1: [number, string] = [1, "x"];
const t2: [number, string] = [1, "x"];
const getters: (() => string)[] = [];
for (let i = 0; i < 2; i++) {
  const t: [string, number] = [names[i]!, i];
  getters.push(() => t[0] + t[1]);
}
console.log(t1 === t2, getters.map((get) => get()).join(","), entry(4), JSON.stringify(divmod(9, 4)));
