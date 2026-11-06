// util.format %j over an error prints the own enumerable properties the
// instance has at the call: a `name` assigned after construction creates
// that property (the base's name lives on the prototype), a redeclared
// cause is created where its initializer runs and prints among the class's
// fields, and a toJSON hook's result is serialized once — a hook on the
// value the hook returned does not run again, while members of that value
// keep their own hooks. Node is the oracle.
import { format } from "node:util";

// A name assigned after construction, on a builtin error, on a program
// subclass without fields, and on one with fields (the fields print first,
// the name takes the position the assignment creates it at).
const plain = new Error("plain");
(plain as unknown as { name: string }).name = "renamed";
console.log(format("%j", plain));

const typed = new TypeError("typed");
(typed as unknown as { name: string }).name = "renamedType";
console.log(format("%j", typed));

class Bare extends Error {}
const bare = new Bare("bare");
(bare as unknown as { name: string }).name = "renamedBare";
console.log(format("%j", bare));

class Fielded extends Error {
  code = "E_FIELDED";
  count = 2;
}
const fielded = new Fielded("fielded");
(fielded as unknown as { name: string }).name = "renamedFielded";
console.log(format("%j", fielded));

// A typed write keeps the class out of the checked-dynamic path: the
// guarded record sends only the renamed instance to the ordered walk, and
// an instance the construction left alone keeps the field record.
class Typed extends Error {
  tag = "t";
}
const renamedTyped = new Typed("typed");
renamedTyped.name = "renamedTyped";
console.log(format("%j", renamedTyped));
console.log(format("%j", new Typed("untouched")));

// A redeclared cause is an own enumerable property created where its
// initializer runs: between the fields declared before and after it.
class Causeful extends Error {
  code = "E_CAUSE";
  cause?: unknown = { at: 1 };
  tail = true;
}
console.log(format("%j", new Causeful("causeful")));

class CauseFirst extends Error {
  cause?: unknown = new Error("inner");
  value = 7;
}
console.log(format("%j", new CauseFirst("first")));

// A rename and a declared cause compose: the cause keeps its declaration
// position and the name takes the end the assignment creates it at.
class Both extends Error {
  kind = "both";
  cause?: unknown = { at: 2 };
}
const both = new Both("both");
both.name = "renamedBoth";
console.log(format("%j", both));

// An uninitialized cause field defines undefined at its position, which
// the JSON walk drops.
class CauseBare extends Error {
  label = "bare";
  cause?: unknown;
}
console.log(format("%j", new CauseBare("bare-cause")));

// A toJSON hook's result is serialized as-is: its own toJSON member does
// not run, while its members do.
class Hooked extends Error {
  toJSON(): unknown {
    return {
      from: "hook",
      inner: {
        toJSON() {
          return { nested: "ran" };
        },
      },
    };
  }
}
console.log(format("%j", new Hooked("hooked")));

class ReturnsHook extends Error {
  toJSON(): unknown {
    return {
      toJSON() {
        return "not this";
      },
      kept: 1,
    };
  }
}
console.log(format("%j", new ReturnsHook("returns-hook")));
