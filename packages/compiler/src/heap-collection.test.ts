import { expect, test } from "vitest";
import { heapPressureCheck } from "./heap-collection.js";

const MB = 1024 * 1024;

/** A heap whose used size the test sets; a collection leaves `live` bytes. */
function fakeHeap(initial: number) {
  const heap = { used: initial, live: initial, collections: 0, reads: 0 };
  const check = heapPressureCheck(
    () => {
      heap.reads++;
      return heap.used;
    },
    () => {
      heap.collections++;
      heap.used = heap.live;
    },
  );
  return { heap, check };
}

test("the check reads the heap every 64th call and at phase ends", () => {
  const { heap, check } = fakeHeap(100 * MB);
  heap.reads = 0;
  for (let i = 0; i < 63; i++) check(false);
  expect(heap.reads).toBe(0);
  check(false);
  expect(heap.reads).toBe(1);
  check(true);
  expect(heap.reads).toBe(2);
});

test("the check collects once the heap doubles and grows by 512 MB", () => {
  const { heap, check } = fakeHeap(100 * MB);
  // Five times the size, but only 400 MB more: no collection.
  heap.used = 500 * MB;
  check(true);
  expect(heap.collections).toBe(0);
  heap.used = 612 * MB;
  check(true);
  expect(heap.collections).toBe(1);
  // The size after the collection is the new baseline: 400 MB live needs 912 MB.
  heap.live = 400 * MB;
  heap.used = 1000 * MB;
  check(true);
  expect(heap.collections).toBe(2);
  heap.used = 900 * MB;
  check(true);
  expect(heap.collections).toBe(2);
  heap.used = 912 * MB;
  check(true);
  expect(heap.collections).toBe(3);
  // From 1 GB live, doubling is the larger bound.
  heap.live = 1024 * MB;
  heap.used = 2000 * MB;
  check(true);
  expect(heap.collections).toBe(4);
  heap.used = 2047 * MB;
  check(true);
  expect(heap.collections).toBe(4);
  heap.used = 2048 * MB;
  check(true);
  expect(heap.collections).toBe(5);
});
