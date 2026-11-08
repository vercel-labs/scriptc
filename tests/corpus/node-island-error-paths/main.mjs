// @requires-libnode
// One program error stays one object along the paths an error takes
// through island code: inside a record and an array, as the reason of a
// rejection the island's Promise.allSettled reports, as the argument of an
// island emitter's 'error' event, as a cause and inside an AggregateError.
// An island error the program caught is the same error again when the
// island hands it back.
import { keep, same, giveBack, wrap, list, catchSame, settledSame, settle, emitter, listenSame, emitError, causeIs, errorsAt, makeKept, throwKept } from "err-view";

class AppError extends Error {
  constructor(m, code) {
    super(m);
    this.name = "AppError";
    this.code = code;
  }
}

function paths(label, e) {
  keep(label, e);
  console.log(label, "again:", same(label, e), "back:", giveBack(e) === e);
  console.log(label, "record:", wrap(e).e === e, "array:", list(e, e)[1] === e);
  console.log(label, "thrown in a callback:", catchSame(label, () => { throw e; }));
}
paths("plain", new Error("p"));
paths("class", new AppError("a", "E_A"));
paths("type", new TypeError("t"));

const e = new AppError("async", "E_ASYNC");
keep("async", e);
console.log("allSettled in the island:", await settledSame("async", [Promise.reject(e), Promise.resolve(1)]));
const settled = await settle([Promise.reject(e), Promise.resolve(1)]);
console.log("allSettled reason:", settled[0].status, settled[0].reason === e, settled[1].status);

const em = emitter();
const seen = listenSame(em, "async");
let got;
em.on("error", (x) => {
  got = x;
});
console.log("emit:", emitError(em, e), seen(), got === e);

const inner = new RangeError("inner");
const outer = new Error("outer", { cause: inner });
keep("inner", inner);
console.log("cause:", causeIs(outer, inner), giveBack(outer) === outer, outer.cause === inner);
const agg = new AggregateError([inner, e], "agg");
console.log("errors:", errorsAt(agg, 0, inner), errorsAt(agg, 1, e), giveBack(agg) === agg, agg.errors[1] === e);

// An island error: caught by the program, handed back, and returned again.
for (const kind of ["plain", "type", "props", "aggregate"]) {
  makeKept(kind, kind);
  let caught;
  try {
    throwKept(kind);
  } catch (x) {
    caught = x;
  }
  console.log("island", kind, "caught:", caught instanceof Error, same(kind, caught), giveBack(caught) === caught);
}
