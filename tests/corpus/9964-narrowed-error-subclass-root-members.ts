// `cause`, `stack` and `code` are members of the Error root that every error
// class shares. Read from an unknown value that `instanceof` narrowed to a
// standard Error subclass (TypeError, RangeError, SyntaxError, ReferenceError,
// EvalError, URIError), they are read as from any other error: the value
// enters through the Error root's checked conversion.
class Clash extends TypeError {
  lane: number;
  constructor(message: string, lane: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.lane = lane;
  }
}

const SENTENCES: Record<string, string> = {
  E_DRY: "The well is dry.",
  E_LOCKED: "The gate is locked.",
};

const show = (v: unknown): string =>
  typeof v === "object" && v !== null
    ? JSON.stringify(Object.keys(v)) + ((v as { message?: string }).message ?? "")
    : String(v);

// An early return on the negated test, then a walk down the chain of causes.
function sentenceFor(err: unknown): string | undefined {
  if (!(err instanceof TypeError)) return undefined;
  let current: unknown = err.cause;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(SENTENCES, code)) return SENTENCES[code];
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function byClass(err: unknown): string {
  if (err instanceof RangeError) return "range:" + show(err.cause);
  if (err instanceof SyntaxError) return "syntax:" + show(err.cause);
  if (err instanceof ReferenceError) return "reference:" + show(err.cause);
  if (err instanceof EvalError) return "eval:" + show(err.cause);
  if (err instanceof URIError) return "uri:" + show(err.cause);
  if (err instanceof TypeError) return "type:" + show(err.cause) + "/" + err.message;
  return "-";
}

function caught(value: unknown): string {
  try {
    throw value;
  } catch (err) {
    return err instanceof TypeError
      ? "caught " + show(err.cause) + " " + String((err.stack ?? "").split("\n")[0])
      : "caught other";
  }
}

const inner = Object.assign(new Error("inner"), { code: "E_LOCKED" });
const middle = new Error("middle", { cause: inner });

console.log(sentenceFor(new TypeError("outer", { cause: middle })));
console.log(sentenceFor(new TypeError("direct", { cause: { code: "E_DRY" } })));
console.log(sentenceFor(new TypeError("no cause")), sentenceFor(new TypeError("other", { cause: { code: "E_X" } })));
console.log(sentenceFor(new RangeError("not a type error", { cause: inner })), sentenceFor("a string"));
// A program subclass of TypeError is narrowed the same way.
console.log(sentenceFor(new Clash("merge", 2, inner)), byClass(new Clash("merge", 3, "why")));

const values: unknown[] = [
  new RangeError("r", { cause: "rc" }),
  new SyntaxError("s", { cause: 7 }),
  new ReferenceError("f", { cause: inner }),
  new EvalError("e"),
  new URIError("u", { cause: null }),
  new TypeError("t", { cause: { nested: true } }),
  new Error("plain", { cause: "ignored" }),
  { cause: "an object's" },
  "text",
  null,
  undefined,
];
console.log(values.map(byClass).join(" | "));
console.log(caught(new TypeError("thrown", { cause: "tc" })));
console.log(caught(new RangeError("thrown")), caught("thrown text"));
