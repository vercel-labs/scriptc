"use strict";
// A generator function's `this` is the receiver of the call that made the
// generator, read when the body runs: after the call returned, between
// other calls with other receivers, and on resumption from a callback.
const counter = {
  base: 10,
  *count(n) {
    for (let i = 0; i < n; i++) yield this.base + i;
  },
};
const other = { base: 100, count: counter.count };

function* plain() {
  yield typeof this;
}

const a = counter.count(3);
const b = other.count(2);
console.log(a.next().value, b.next().value, a.next().value, b.next().value, a.next().value);
console.log([...counter.count.call({ base: 1000 }, 2)].join(","));
console.log([...plain()].join(","), [...plain.call("text")].join(","));

const lazy = other.count(3);
const seen = [10, 20].map(function () {
  return `${lazy.next().value}${this === undefined ? "" : "!"}`;
});
console.log(seen.join(","), lazy.next().value);

const holder = {
  label: "async",
  async *steps() {
    yield this.label;
    await null;
    yield `${this.label} again`;
  },
};
(async () => {
  const out = [];
  for await (const step of holder.steps()) out.push(step);
  console.log(out.join(","));
})();
