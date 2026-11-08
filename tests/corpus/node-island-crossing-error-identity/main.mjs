// @requires-libnode
// An error keeps its identity, class, fields, cause, errors and stack when
// it crosses the boundary: a native error thrown through island frames is
// the same object when native code catches it, island code that catches it
// reads its fields, and an island error does the same the other way round.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (...a) => console.log(...a);

class ValidationError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
  retryable() {
    return false;
  }
}
class NotFound extends ValidationError {}

const firstLine = (e) => String(e.stack).split("\n")[0];
const original = new ValidationError("bad input", 422);
const stack = original.stack;
const check = (label, e) =>
  log(label, e === original, e instanceof ValidationError, e instanceof Error, e.status, e.name, e.retryable(), e.stack === stack);

// One round trip: thrown by a native callback through island frames.
try {
  lib.run(() => {
    throw original;
  });
} catch (e) {
  check("sync", e);
}
try {
  await lib.runAsync(async () => {
    throw original;
  });
} catch (e) {
  check("async", e);
}
try {
  lib.rethrow(() => {
    throw original;
  });
} catch (e) {
  check("rethrown", e);
}
// Two round trips: native, island, native, island, native.
try {
  lib.run(() => lib.rethrow(() => {
    throw original;
  }));
} catch (e) {
  check("twice", e);
}
// As an argument and a return value, and compared in island code.
lib.keep(original);
log("kept", lib.same(original), lib.kept() === original, lib.same(new ValidationError("other", 1)));
// As a cause, of a native error and of an island error.
try {
  lib.each([1], () => {
    throw new Error("outer", { cause: original });
  });
} catch (e) {
  log("cause", e.message, e.cause === original, firstLine(e));
}
try {
  lib.wrap(() => {
    throw original;
  });
} catch (e) {
  log("wrapped", e.message, e.cause === original, e.cause.status, e.cause instanceof ValidationError);
}
// In an AggregateError.
const many = new AggregateError([original, new TypeError("second"), "third"], "many");
try {
  lib.run(() => {
    throw many;
  });
} catch (e) {
  log("aggregate", e === many, e instanceof AggregateError, e.errors.length, e.errors[0] === original, e.errors[1].message, e.errors[2]);
}

// What island code reads from a native error it caught.
const thrower = (e) => () => {
  throw e;
};
log("island reads", lib.describe(thrower(new ValidationError("seen by island", 400)), ValidationError));
log("island reads", lib.describe(thrower(new NotFound("deeper", 404)), ValidationError));
log("island reads", lib.describe(thrower(new Error("with cause", { cause: new Error("inner") }))));
log("island reads", lib.describe(thrower(new TypeError("plain type"))));
log("island reads", lib.describe(thrower(new RangeError("plain range"))));
log("island reads", lib.describe(thrower(Object.assign(new Error("coded"), { code: "E_NATIVE" }))));
log("island reads", lib.describe(thrower(many)));
log("island reads", lib.describe(thrower(new Error())));

// Island code that keeps a native error sees what native code changes on
// it afterwards: message, name, code, stack and fields.
const changing = new Error("first");
changing.status = 1;
lib.keep(changing);
log("kept error", lib.read(changing));
changing.message = "second";
changing.status = 2;
log("kept error", lib.read(changing));
changing.name = "Renamed";
changing.code = "E_CHANGED";
log("kept error", lib.read(changing));
changing.stack = "replaced stack\n    at nowhere";
log("kept error", lib.read(changing));

// The other direction: an island error through native frames.
const island = lib.make("from the island", 7);
const islandStack = island.stack;
lib.keep(island);
log("island", lib.callAndCatch(() => {
  throw island;
}, island));
log("island twice", lib.callAndCatch(() => lib.run(lib.throwing(island)), island));
try {
  lib.run(lib.throwing(island));
} catch (e) {
  log("island caught natively", e instanceof lib.IslandError, e instanceof Error, e.detail, e.where(), e.name, e.stack === islandStack, lib.same(e));
}
try {
  lib.run(() => lib.run(lib.throwing(island)));
} catch (e) {
  log("island caught natively twice", e.detail, lib.same(e));
}
log("done");
