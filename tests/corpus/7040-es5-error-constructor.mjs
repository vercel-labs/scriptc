// A constructor function that inherits from Error.prototype, the pre-class
// way of declaring an error type.
function ParseFailure(reason, position) {
  Error.call(this);
  this.name = "ParseFailure";
  this.reason = reason;
  this.position = position;
  this.message = reason + (position === undefined ? "" : " at " + position);
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, this.constructor);
  } else {
    this.stack = new Error().stack || "";
  }
}
ParseFailure.prototype = Object.create(Error.prototype);
ParseFailure.prototype.constructor = ParseFailure;
ParseFailure.prototype.toString = function toString(compact) {
  return this.name + ": " + this.reason + (compact ? "" : " (position " + this.position + ")");
};

const failure = new ParseFailure("unexpected token", 7);
console.log(failure instanceof ParseFailure, failure instanceof Error, failure.constructor === ParseFailure);
console.log(failure.name, "|", failure.message, "|", failure.reason, failure.position);
console.log(failure.toString(), "|", failure.toString(true), "|", String(failure), "|", `${failure}`);
console.log(Object.keys(failure), JSON.stringify(failure));
console.log(typeof failure.stack, failure.stack.split("\n")[0], Object.keys(failure).includes("stack"));
console.log(Object.prototype.toString.call(failure), Error.isError(failure));

try {
  throw new ParseFailure("thrown");
} catch (caught) {
  console.log(caught instanceof Error, caught instanceof ParseFailure, caught.reason, caught.message);
}
const values = [new ParseFailure("in a list"), new Error("plain"), { name: "Fake", message: "x" }, "text"];
console.log(values.map((value) => value instanceof Error));

// The inherited members of Error.prototype.
const bare = Object.create(Error.prototype);
console.log(bare instanceof Error, bare.name, JSON.stringify(bare.message), String(bare), Object.keys(bare));
console.log(Error.prototype.name, JSON.stringify(Error.prototype.message), Error.prototype instanceof Error);
const record = Object.create(Error.prototype);
record.name = "N";
record.message = "M";
console.log(String(record), `${Object.create(record)}`);

// captureStackTrace on other objects: the header follows name and message.
const target = { name: "Custom", message: "details", toString() { return "ignored"; } };
Error.captureStackTrace(target);
console.log(target.stack.split("\n")[0], Object.keys(target));
const empty = {};
Error.captureStackTrace(empty);
console.log(empty.stack.split("\n")[0], typeof Error.captureStackTrace);

// A subtype of the subtype.
function StrictFailure(reason) {
  ParseFailure.call(this, reason, 0);
  this.name = "StrictFailure";
}
StrictFailure.prototype = Object.create(ParseFailure.prototype);
StrictFailure.prototype.constructor = StrictFailure;
const strict = new StrictFailure("strict mode");
console.log(strict instanceof StrictFailure, strict instanceof ParseFailure, strict instanceof Error, strict.toString(true));

// A class that extends Error calls it too, directly or through `?.`.
class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenError";
    Error.captureStackTrace(this, TokenError);
  }
}
class LexError extends TokenError {
  constructor(message) {
    super(message), (this.name = "LexError"), Error.captureStackTrace?.(this, this.constructor);
  }
}
for (const error of [new TokenError("bad token"), new LexError("bad char")]) {
  console.log(error.name, error.message, error.stack.split("\n")[0], error instanceof TokenError, Object.keys(error));
}
