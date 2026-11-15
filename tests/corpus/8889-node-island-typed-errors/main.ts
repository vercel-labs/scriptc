// @requires-libnode
// Errors built by the typed constructor crossing into a Node island: Node
// sees the same error, with the same own properties, as for one built by
// the checked constructor from equal inputs, thrown or passed, and the
// island's answer comes back unchanged. An error without a message is
// described without its own-property column: the crossing gives the Node
// error a message property either way.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

class Failure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Failure";
  }
}
class Silent extends Error {
  constructor() {
    super();
  }
}

const text: string = "same text";
const untyped: any = "same text";

console.log("typed", lib.describe(new Error(text)));
console.log("checked", lib.describe(new Error(untyped)));
console.log("checked options", lib.describe(new Error(text, {})));
console.log("typed absent", lib.describeBare(new Error()));
console.log("checked absent", lib.describeBare(new Error(undefined, {})));
console.log("typed TypeError", lib.describe(new TypeError(`template ${text}`)));
console.log("typed RangeError", lib.describeBare(new RangeError()));
console.log("super(message)", lib.describe(new Failure("failed")));
console.log("super()", lib.describeBare(new Silent()));

// Thrown natively inside a callback the island runs, caught by the island.
console.log("thrown", lib.caught(() => {
  throw new SyntaxError("thrown through the island");
}));
console.log("thrown subclass", lib.caught(() => {
  throw new Failure("subclass through the island");
}));

// Through the island and back.
try {
  lib.rethrow(new EvalError("round trip"));
} catch (error) {
  if (error instanceof Error) console.log("back", error instanceof EvalError, error.name, error.message);
}
