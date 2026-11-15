import { parallelReduce } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental): parallelReduce's loops are Node's.
// A call the compiler cannot show safe runs its chunks on the calling
// thread, and each chunk's part runs, then its combine, before the next
// chunk — so effects shared between the two callbacks keep Node's order.

const log: string[] = [];
const total = parallelReduce(
  8,
  0,
  (start, end) => {
    log.push(`part ${start}`);
    return start * 10;
  },
  (left, right) => {
    log.push(`combine ${right}`);
    return left + right;
  },
  { grain: 4 },
);
console.log(log.join(", "));
console.log(total);

// A throw in one chunk's part leaves the combines before it run and the
// throwing chunk without one, as Node's loop does.
const events: string[] = [];
try {
  parallelReduce(
    8,
    0,
    (start, end) => {
      events.push(`part ${start}`);
      if (start === 4) throw new Error("stop");
      return start;
    },
    (left, right) => {
      events.push(`combine ${right}`);
      return left + right;
    },
    { grain: 4 },
  );
} catch (error) {
  events.push(`caught ${(error as Error).message}`);
}
console.log(events.join(", "));
