// An element taken out of an array that was just made (pop, shift, the
// elements a splice removes), and a copy of a Map or a Set that holds the
// same members, kept after the array or the collection is gone. The taken
// element and the copied members are values of the first group: they are
// read again here after the heap has been reused.
interface Ticket {
  seat: number;
}
function tickets(base: number): Ticket[] {
  const made: Ticket[] = [];
  for (let i = 0; i < 5; i++) made.push({ seat: base + i });
  return made;
}
function bySeat(base: number): Map<number, Ticket> {
  const index = new Map<number, Ticket>();
  for (let i = 0; i < 5; i++) index.set(i, { seat: base + i });
  return index;
}
function pool(base: number): Set<Ticket> {
  const all = new Set<Ticket>();
  for (let i = 0; i < 5; i++) all.add({ seat: base + i });
  return all;
}
function seats(list: Ticket[]): number {
  let total = list.length * 1000;
  for (const ticket of list) total += ticket.seat;
  return total;
}
function churn(): number {
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const spare = tickets(900 + i);
    const index = bySeat(800 + i);
    total += spare.length + index.size;
  }
  return total;
}

// Used in place at module level.
const lastOne = tickets(10).pop()!;
const firstOne = tickets(20).shift()!;
const cut = tickets(30).splice(1, 2);
const swapped = tickets(40).splice(0, 2, { seat: 49 });
const indexCopy = new Map(bySeat(50));
const poolCopy = new Set(pool(60));
const valueSet = new Set(bySeat(70).values());
const listed = [...pool(80)];
churn();
console.log(lastOne.seat, firstOne.seat, seats(cut), seats(swapped));
console.log(seats([...indexCopy.values()]), seats([...poolCopy]), seats([...valueSet]), seats(listed));

// Off a local that goes away with its function.
let taken: Ticket = { seat: -1 };
let removed: Ticket[] = [];
let copied = new Map<number, Ticket>();
let pooled = new Set<Ticket>();
function takeLast(): number {
  const queue = tickets(100);
  taken = queue.pop()!;
  return queue.length;
}
function takeFirst(): number {
  const queue = tickets(110);
  taken = queue.shift()!;
  return queue.length;
}
function takeSome(): number {
  const queue = tickets(120);
  removed = queue.splice(1, 2, { seat: 129 }, { seat: 128 });
  return queue.length;
}
function copyIndex(): number {
  const index = bySeat(130);
  copied = new Map(index);
  return index.size;
}
function copyPool(): number {
  const all = pool(140);
  pooled = new Set(all);
  return all.size;
}
const a = takeLast();
churn();
const afterPop = taken.seat;
const b = takeFirst();
churn();
const afterShift = taken.seat;
const c = takeSome();
const d = copyIndex();
const e = copyPool();
churn();
console.log(a, afterPop, b, afterShift, c, seats(removed), d, seats([...copied.values()]), e, seats([...pooled]));

// A worklist whose items leave it one by one.
const done: Ticket[] = [];
function drain(): number {
  const work = tickets(200);
  let steps = 0;
  while (work.length > 0) {
    const next = work.pop()!;
    if (next.seat % 2 === 0) done.push(next);
    steps++;
  }
  return steps;
}
const steps = drain();
churn();
console.log(steps, seats(done));

// A ticket written into a list that goes away: inserted by splice or by
// fill, into a local list or into the list where it is made. The list's
// group holds the ticket, which is released with it.
function insertLocal(): number {
  const queue = tickets(400);
  const out = queue.splice(1, 2, { seat: 499 });
  queue.fill({ seat: 498 }, 0, 1);
  return queue.length * 10 + out.length + queue[0]!.seat;
}
function insertInPlace(): number {
  const out = tickets(410).splice(1, 2, { seat: 419 });
  const size = tickets(420).push({ seat: 429 });
  return seats(out) + size;
}
console.log(insertLocal(), insertInPlace());

// Removed elements that stay in their function keep working.
function local(): number {
  const queue = tickets(300);
  const top = queue.pop()!;
  const head = queue.shift()!;
  return top.seat + head.seat + queue.length;
}
console.log(local());
