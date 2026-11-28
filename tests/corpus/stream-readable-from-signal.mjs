// Readable.from's signal option: an abort before the first read destroys the
// stream with AbortError, and a signal that never aborts leaves it alone.
import { Readable } from "node:stream";

const before = new AbortController();
before.abort();
const first = [];
try {
  for await (const chunk of Readable.from(["a", "b"], { signal: before.signal })) first.push(String(chunk));
  console.log(`before: done ${first.join(",")}`);
} catch (error) {
  console.log(`before: ${error.name} ${first.join(",")}`);
}

const after = new AbortController();
const second = [];
for await (const chunk of Readable.from(["a", "b"], { signal: after.signal })) second.push(String(chunk));
console.log(`after: done ${second.join(",")}`);
after.abort();

// An abort while the source is being read ends the iteration with AbortError
// at the chunk it had already delivered.
const slow = {
  async *[Symbol.asyncIterator]() {
    yield "a";
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield "b";
  },
};
const controller = new AbortController();
setTimeout(() => controller.abort(), 5);
const during = [];
try {
  for await (const chunk of Readable.from(slow, { signal: controller.signal })) during.push(String(chunk));
  console.log(`during: done ${during.join(",")}`);
} catch (error) {
  console.log(`during: ${error.name} ${during.join(",")}`);
}
