// A JS method whose JSDoc return type is a union of the class and a string
// (commander's `name()` declares `@return {(string|Command)}`). The result's
// static type is `string | Command`, and a method call on it reads the member
// off whichever value the call produced: on the class arm it runs the method
// with the instance as the receiver, on the string arm it is V8's
// "is not a function" TypeError.
class Builder {
  /** @param {string} str @returns {string | Builder} */
  name(str) {
    if (str === undefined) return this.name_;
    this.name_ = str;
    return this;
  }

  /** @param {string} version @returns {Builder} */
  version(version) {
    this.version_ = version;
    return this;
  }
}

/** @param {boolean} armed @returns {string | Builder} */
function maybe(armed) {
  return armed ? new Builder() : "plain";
}

// The chained form from the refusal itself: the receiver is the call's
// result. The class arm returns the same instance at every step.
const builder = maybe(true).name("demo").version("1.0.0");
console.log(builder.name_, builder.version_);

// The class arm keeps the instance as the receiver, so the write is visible
// through the object the call started from.
const target = new Builder();
target.name("kept");
console.log(target.name(), target.name_);

// The string arm has no such member: the call throws, and the message names
// the callee the way Node does.
const plain = maybe(false);
try {
  plain.version("1.0.0");
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}

// The arms are decided per call, not per variable: the same binding-style
// value can be either.
for (const armed of [true, false]) {
  const value = maybe(armed);
  try {
    value.version("2.0.0");
    console.log("called", armed);
  } catch (error) {
    console.log("threw", armed, error.message);
  }
}
