// The `in` operator over an instance of an Error subclass finds the
// methods and accessors of its class and of the classes it extends, the
// own fields, and Error.prototype's name and message, as Node does; an
// absent name answers false.
"use strict";

class CodedError extends Error {
  constructor(message) {
    super(message);
    this.code = "E_CODED";
  }
  get kind() {
    return "coded";
  }
  describe() {
    return `${this.kind}: ${this.message}`;
  }
}

class RetryError extends CodedError {
  retry() {
    return true;
  }
}

function probe(label, value) {
  const names = ["kind", "describe", "retry", "code", "name", "message", "missing"];
  console.log(label, names.map((name) => `${name}:${name in value}`).join(" "));
}

const coded = new CodedError("coded failure");
const retry = new RetryError("retry failure");
probe("coded", coded);
probe("retry", retry);
try {
  throw retry;
} catch (caught) {
  probe("caught", caught);
}
