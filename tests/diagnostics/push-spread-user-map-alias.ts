// A spread whose source was built by a USER-DEFINED map() keeps the
// elements that map returns (here one object it hands out every call), so a
// push into a wider element layout cannot copy them without breaking the
// identity JavaScript keeps. Only the builtin Array.prototype.map builds
// fresh elements; this shape keeps its refusal.
type Narrow = { index: number };
type Wide = { index: number; kind?: string };

const kept: Narrow = { index: 7 };
const mirror = {
  map(callback: (value: Narrow) => Narrow): Narrow[] {
    callback(kept);
    return [kept];
  },
};

const wide: Wide[] = [];
wide.push(...mirror.map((value) => ({ index: value.index })));
kept.index = 9;
console.log(wide[0]!.index, JSON.stringify(wide));
