// A callee called in a loop with an array of one constant length compiles to
// a specialized copy; an array that can grow keeps the general copy. Both
// copies must answer exactly as Node does.
interface Body {
  x: number;
  y: number;
}

const bodies: Body[] = [
  { x: 0, y: 1 },
  { x: 1, y: 2 },
  { x: 2, y: 3 },
  { x: 3, y: 4 },
  { x: 4, y: 5 },
];

const pair: Body[] = [
  { x: 1, y: 1 },
  { x: 2, y: 2 },
  { x: 3, y: 3 },
];

function energyOf(list: Body[]): number {
  let total = 0;
  for (let i = 0; i < list.length; i++)
    total += list[i]!.x * list[i]!.y + list.length;
  return total;
}

function neighbourSum(list: Body[]): number {
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    if (i + 1 < list.length) total += list[i]!.x + list[i + 1]!.y;
  }
  return total;
}

function countOf(list: Body[]): number {
  return list.length;
}

// A callee that grows its own parameter is never specialized.
function extend(list: Body[], extra: Body): number {
  list.push(extra);
  return list.length;
}

// Calls inside a loop: the immutable global, a three-element local and an
// array literal of two elements, so the callee has two constant lengths.
let total = 0;
for (let round = 0; round < 3; round++) {
  total += energyOf(bodies);
  total += neighbourSum(bodies);
  total += countOf(bodies);
  total += energyOf([
    { x: 2, y: 5 },
    { x: 3, y: 7 },
  ]);
  total += energyOf(pair);
  total += neighbourSum(pair);
}
console.log(total);

// The same functions on arrays that grow, on slice results and past the end:
// the general copy answers.
const growing: Body[] = [{ x: 1, y: 2 }];
console.log(energyOf(growing), neighbourSum(growing), countOf(growing));
growing.push({ x: 5, y: 6 });
console.log(energyOf(growing), neighbourSum(growing), countOf(growing));

const sizes: Body[] = [{ x: 0, y: 0 }];
console.log(extend(sizes, { x: 9, y: 9 }), extend(sizes, { x: 8, y: 8 }), sizes.length);

console.log(bodies[5]);
console.log(energyOf(bodies), neighbourSum(bodies));
console.log(countOf(bodies.slice(0, 2)), countOf(bodies.slice(2)));
