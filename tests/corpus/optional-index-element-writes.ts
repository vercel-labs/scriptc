// Element writes whose index comes from for...of over a number[] field the
// class also writes by index (so the loop variable's storage may be
// undefined, a hole read): typed-array writes, compound and update writes,
// a write used as a value, and a destructuring target all convert the
// index with ToNumber, as the element reads do.
class Heap {
  private k: number[] = [];
  push(v: number): void {
    const i = this.k.length;
    this.k.push(v);
    this.k[i] = v;
  }
  all(): number[] {
    return this.k;
  }
}
const h = new Heap();
h.push(2);
h.push(0);
h.push(1);
const cost = new Float64Array(4);
for (const i of h.all()) cost[i] = i * 1.5;
console.log(Array.from(cost).join(","));
const counts = new Int32Array(3);
for (const i of h.all()) counts[i] += 10;
for (const i of h.all()) counts[i]++;
console.log(Array.from(counts).join(","));
const marks = new Uint8Array(3);
let last = 0;
for (const i of h.all()) last = marks[i] = i + 1;
console.log(Array.from(marks).join(","), last);
const plain = [0, 0, 0];
for (const i of h.all()) [plain[i]] = [i * 2];
for (const i of h.all()) plain[i] += 1;
console.log(plain.join(","));
