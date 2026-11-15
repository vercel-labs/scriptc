// util.inspect of Error values with showHidden: Node lists the error's own
// keys in own-key order — the stack accessor, the message, the extra
// properties the program added, hidden ones bracketed, own symbols last —
// and prints the cause and AggregateError's errors as ordinary keys.
// Without showHidden the stack, message and name are dropped from the key
// list and the base `[Name: message]` carries them. Every stack is cleared
// first so the program's own frames never enter the text.
import * as util from "node:util";

const show = (label: string, value: any, options?: any): void => {
  console.log(`${label}: ${util.inspect(value, options)}`);
};
const hidden = { showHidden: true };

const plain: any = new Error("boom");
plain.stack = "";
show("plain", plain, hidden);
show("plain bare", plain);
show("plain nested", { e: plain }, hidden);
show("plain nested depth1", { e: plain }, { showHidden: true, depth: 1 });
show("plain nested depth0", { e: plain }, { showHidden: true, depth: 0 });
show("plain depth0", plain, { showHidden: true, depth: 0 });

const extra: any = new Error("x");
extra.stack = "";
extra.code = "E";
Object.defineProperty(extra, "hiddenCode", { value: "H", enumerable: false });
extra[Symbol("s")] = 1;
show("extra", extra, hidden);
show("extra bare", extra);

const empty: any = new Error();
empty.stack = "";
show("no message", empty, hidden);
show("no message bare", empty);

const renamed: any = new RangeError("r");
renamed.stack = "";
renamed.name = "X";
show("renamed", renamed, hidden);
show("renamed bare", renamed);

const cause: any = new TypeError("inner");
cause.stack = "";
const outer: any = new Error("outer", { cause });
outer.stack = "";
show("cause", outer, hidden);
show("cause nested depth1", { o: outer }, { showHidden: true, depth: 1 });
show("cause nested depth0", { o: outer }, { showHidden: true, depth: 0 });

class Custom extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Custom";
    this.stack = "";
  }
}
const custom: any = new Custom("made");
show("subclass", custom, hidden);
show("subclass bare", custom);

const self: any = new Error("self");
self.stack = "";
self.self = self;
show("self", self, hidden);

const getters: any = new Error("boom");
getters.stack = "";
show("getters", getters, { showHidden: true, getters: true });

show("in array", [plain, extra], hidden);
show("in map", new Map<string, any>([["e", plain]]), hidden);

const aggregate: any = new AggregateError([plain, extra], "agg");
aggregate.stack = "";
show("aggregate", aggregate, hidden);
show("aggregate bare", aggregate);

console.log(`format o: ${util.format("%o", plain)}`);
console.log(`format O: ${util.format("%O", plain)}`);
console.log(`formatWithOptions: ${util.formatWithOptions({ showHidden: true }, "%o", extra)}`);
