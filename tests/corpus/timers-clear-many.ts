// clearTimeout/clearInterval, refresh, ref/unref, and hasRef find their
// timer through a handle index (the runtime used to scan the whole timer
// heap per call, so arming and clearing many timers was quadratic). Pins
// which timers fire, their order, and handle bookkeeping across heap moves.
const fired: number[] = [];
const handles = [setTimeout(() => fired.push(0), 5)];
for (let i = 1; i < 30000; i++) {
  const delay = 1 + ((i * 7) % 13);
  handles.push(setTimeout(() => fired.push(i), delay));
}
// Clear two of every three; clearing twice is a no-op.
for (let i = 0; i < handles.length; i++) {
  const handle = handles[i];
  if (i % 3 !== 0 && handle !== undefined) {
    clearTimeout(handle);
    if (i % 5 === 0) clearTimeout(handle);
  }
}

// Intervals mixed into the same heap: one clears itself, one is cleared by
// a timeout, and a third is unref'd.
let ticksA = 0;
const intervalA = setInterval(() => {
  ticksA++;
  if (ticksA === 3) clearInterval(intervalA);
}, 2);
let ticksB = 0;
const intervalB = setInterval(() => ticksB++, 3);
setTimeout(() => clearInterval(intervalB), 20);
const intervalC = setInterval(() => {}, 1000);
intervalC.unref();
console.log("hasRef", intervalC.hasRef(), handles[3]!.hasRef());

// refresh() re-arms a timer that sits deep in the heap.
let refreshedAt = -1;
const refreshed = setTimeout(() => {
  refreshedAt = fired.length;
}, 4);
refreshed.refresh();

// A timer that clears a later sibling from its callback.
let siblingRan = false;
const sibling = setTimeout(() => {
  siblingRan = true;
}, 30);
setTimeout(() => clearTimeout(sibling), 10);

setTimeout(() => {
  // Timers sharing a delay fire in registration order.
  let ordered = true;
  const lastByDelay = new Map<number, number>();
  for (const i of fired) {
    const delay = i === 0 ? 5 : 1 + ((i * 7) % 13);
    if ((lastByDelay.get(delay) ?? -1) > i) ordered = false;
    lastByDelay.set(delay, i);
  }
  let wrong = 0;
  for (const i of fired) if (i % 3 !== 0) wrong++;
  console.log(fired.length, wrong, ordered, ticksA, ticksB > 0, refreshedAt >= 0, siblingRan);
  const first = handles[0];
  if (first !== undefined) clearTimeout(first); // already fired: no-op
}, 60);
