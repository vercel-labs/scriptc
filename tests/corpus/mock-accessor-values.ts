// mock.getter and mock.setter on an object literal's accessors (a
// checked-dynamic object here): the mock becomes the accessor, reads and
// writes go through it, restore() puts the original descriptor back, and a
// { times } budget restores it after its count.
import { mock } from "node:test";

const holder = {
  _v: 1,
  get v(): number {
    return this._v;
  },
  set v(x: number) {
    this._v = x;
  },
};

const getSpy = mock.getter(holder, "v", () => 42);
console.log(holder.v, holder.v, getSpy.mock.callCount());
getSpy.mock.restore();
console.log(holder.v);

const setSpy = mock.setter(holder, "v", (x: number) => {
  holder._v = x * 2;
});
holder.v = 5;
console.log(holder._v, setSpy.mock.callCount(), setSpy.mock.calls[0]!.arguments);
setSpy.mock.restore();
holder.v = 7;
console.log(holder._v);

const once = mock.getter(holder, "v", () => 5, { times: 1 });
console.log(holder.v, holder.v, once.mock.callCount());
