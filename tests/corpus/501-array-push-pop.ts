// push (including its return value — the new length, JS-exact) and pop.
// pop on an empty array traps (documented divergence), so lengths are
// always checked here, as real code must.
const stack: number[] = [];
console.log(stack.push(1), stack.push(2), stack.push(3));
console.log(stack.length);
console.log(stack.pop(), stack.pop());
console.log(stack.length, stack[0]);

// push return value in expressions and conditions
const xs: number[] = [5];
const newLen: number = xs.push(6);
console.log(newLen, newLen === xs.length);
if (xs.push(7) === 3) {
  console.log("three now");
}

// pop into locals; drain a stack with .length in the condition
const names: string[] = ["ada", "grace", "hopper"];
const last: string | undefined = names.pop();
console.log(last ?? "missing", names.length);
while (names.length > 0) {
  console.log(names.pop() ?? "missing", names.length);
}

// booleans round-trip
const bits: boolean[] = [];
bits.push(true);
bits.push(false);
console.log(bits.pop(), bits.pop(), bits.length);

// pushing pushes references for nested arrays
const rows: number[][] = [];
rows.push([1, 2]);
rows.push([3]);
console.log(rows.length, rows[0][0], rows[1][0]);
const popped: number[] | undefined = rows.pop();
console.log(popped === undefined ? "missing" : popped[0], rows.length);

// interleaved push/pop keeps LIFO order
const log: string[] = [];
log.push("a");
log.push("b");
console.log(log.pop());
log.push("c");
console.log(log.pop(), log.pop(), log.length);
