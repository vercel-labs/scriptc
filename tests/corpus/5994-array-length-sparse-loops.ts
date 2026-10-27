// Index loops over sparse arrays with lengths beyond 2^31, holes, and arrays
// that become sparse while a loop runs. Dense-loop fast paths must leave all
// of these on the general path.

function partialAscending(a: number[], limit: number): string {
  let sum = 0;
  let passes = 0;
  for (let i = 0; i < a.length; i++) {
    if (passes++ === limit) break;
    sum += a[i] === undefined ? -1 : a[i];
  }
  return `${passes} ${sum}`;
}

function partialDescending(a: number[], limit: number): string {
  let last = -1;
  let passes = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    if (passes++ === limit) break;
    last = i;
  }
  return `${passes} ${last}`;
}

function stridedFromEnd(a: number[]): string {
  const hits: number[] = [];
  for (let i = a.length - 1; i >= 0 && hits.length < 3; i -= 1000000000) hits.push(i);
  return hits.join(",");
}

function whileWithLimit(a: number[], limit: number): number {
  let i = 0;
  let present = 0;
  while (i < a.length && i < limit) {
    if (a[i] !== undefined) present++;
    i++;
  }
  return present * 1000 + i;
}

function writeAtCounter(a: number[], limit: number): string {
  for (let i = 0; i < a.length && i < limit; i++) a[i] = i * 2;
  return `${a.length} ${a[0]} ${a[limit - 1]} ${a[limit]}`;
}

function holeSum(a: number[]): string {
  let sum = 0;
  let nan = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (Number.isNaN(v + 0)) nan++;
    else sum += v;
  }
  return `${sum} ${nan}`;
}

function firstValues(a: number[]): string {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    if (i === 4) break;
    s += a[i];
  }
  let t = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    if (i < a.length - 2) break;
    t += a[i];
  }
  let u = 0;
  for (let i = 0; i < a.length; i += 2) {
    if (i > 2) break;
    u += a[i];
  }
  return `${s} ${t} ${u}`;
}

const huge: number[] = [1, 2, 3];
huge.length = 3e9;
console.log(huge.length);
console.log(partialAscending(huge, 5));
console.log(firstValues(huge), firstValues([1, 2, 3, 4, 5]));
console.log(partialDescending(huge, 4));
console.log(stridedFromEnd(huge));
console.log(whileWithLimit(huge, 6));
console.log(writeAtCounter(huge, 4));
console.log(huge.length);

const edge: number[] = [];
edge[4294967294] = 7;
console.log(edge.length, partialDescending(edge, 2), partialAscending(edge, 3));

const holey = [1, 2];
holey[3] = 4;
holey[5] = 6;
console.log(holeSum(holey));
const sparse: number[] = [1, 2];
sparse[10] = 5;
console.log(holeSum(sparse));

// Becomes sparse mid-loop: a write far past the end through another binding.
function sparseMidLoop(): string {
  const a = [1, 2, 3, 4];
  const b = a;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    if (i === 1) b[3000000000] = 9;
    if (i > 6) break;
    sum += a[i] === undefined ? 100 : a[i];
  }
  return `${sum} ${a.length}`;
}
console.log(sparseMidLoop());

function holeMidLoop(): string {
  const a = [1, 2, 3, 4, 5];
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    if (i === 1) a.length = 3;
    if (i === 2) a.length = 5;
    sum += a[i] === undefined ? 100 : a[i];
  }
  return `${sum}`;
}
console.log(holeMidLoop());

const objects: { v: number }[] = [{ v: 1 }, { v: 2 }, { v: 3 }];
objects.length = 5;
try {
  let total = 0;
  for (let i = 0; i < objects.length; i++) total += objects[i].v;
  console.log(total);
} catch (e) {
  console.log(e instanceof TypeError ? "TypeError" : "other");
}
