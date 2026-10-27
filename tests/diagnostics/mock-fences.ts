// node:test mocks lower for mock.fn([original[, implementation]]),
// mock.method(object, methodName[, implementation]) on records, their
// t.mock twins, and the trackers' restoreAll and reset. The rest of the
// mock surface is refused, each with a named diagnostic: mock.fn() without
// an original for a function type whose return type does not include
// undefined; mock.method on a class instance or a builtin object, with
// an options object, or with an implementation of another type when the
// result is used; and functions whose union return type has no undefined
// arm (the calls log records undefined for calls that throw).
import { mock, test } from "node:test";

const add = mock.fn((a: number, b: number) => a + b); // lowers
add(1, 2);

const empty = mock.fn(); // lowers
empty(1, "two");

const counted = mock.fn<() => number>(); // no original, returns number
counted();

const obj = { value: () => 1 };
mock.method(obj, "value"); // lowers
mock.restoreAll(); // lowers
mock.reset(); // lowers

class Counter {
  count(): number {
    return 1;
  }
}
mock.method(new Counter(), "count"); // class instance
mock.method(console, "log"); // builtin object
mock.method(obj, "value", { times: 1 }); // options
const other = mock.method(obj, "value", () => "one"); // implementation of another type
other();

test("tracker methods on t.mock", (t) => {
  t.mock.method(obj, "value"); // lowers
  t.mock.method(obj, "value", { times: 2 }); // options
});

const pick = mock.fn((flag: boolean): number | string => (flag ? 1 : "one")); // union without undefined
pick(true);
