// A run-time %s over an instance held untyped answers through the class's
// own inspector whatever the class's fields are: the conversion does not
// build the instance's field view to look for a toString, so fields that
// have no checked form (a Map of functions, a promise, a WeakMap) do not
// get in the way.
import { inspect } from "node:util";

const pair: string = process.argv.length > 99 ? "" : "%s|%s";

class Plain {
  a = 1;
  [inspect.custom](): string {
    return "custom plain";
  }
}
class WithHandlers {
  handlers = new Map<string, () => void>([["x", () => {}]]);
  [inspect.custom](): string {
    return "custom with handlers";
  }
}
class WithPromise {
  pending: Promise<number> = Promise.resolve(1);
  weak = new WeakMap<object, number>();
  [inspect.custom](): string {
    return "custom with a promise";
  }
}
class NoInspector {
  handlers = new Map<string, () => void>([["x", () => {}]]);
}

const values: [string, unknown][] = [
  ["plain", new Plain()],
  ["handlers", new WithHandlers()],
  ["promise", new WithPromise()],
  ["none", new NoInspector()],
];
for (const [label, value] of values) console.log(pair, label, value);
console.error(pair, "stderr", new WithPromise());
