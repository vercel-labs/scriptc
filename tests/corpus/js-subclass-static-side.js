// A JavaScript class whose STATIC side does not match its base's: an Error
// subclass declaring `static isError(input)` with a JSDoc signature unlike
// `Error.isError`'s type predicate, and two user classes whose static
// factory returns a narrower type than the base's. The JSDoc types are
// documentation Node never reads: the statics install on the constructor
// and answer at the call exactly as in Node, while a checked file keeps
// tsc's assignment error (TS2417).
'use strict';

class HTTPError extends Error {
  /**
   * @param {unknown} input
   * @returns {boolean}
   */
  static isError(input) {
    return input instanceof HTTPError || (input instanceof Error && input.name === "HTTPError");
  }

  constructor(message) {
    super(message);
    this.name = "HTTPError";
    this.status = 500;
  }
}

class Base {
  static make() {}
  /** @type {string} */
  static tag = "base";
}

class Sub extends Base {
  /**
   * @returns {Sub}
   */
  static make() {
    return new Sub();
  }
  /** @type {number} */
  static tag = 7;
}

const error = new HTTPError("boom");
const plain = new Error("plain");
console.log("own:", HTTPError.isError(error), HTTPError.isError(plain));
console.log("named:", HTTPError.isError({ name: "HTTPError" }));
console.log("instance:", error instanceof Error, error.status, error.name);
console.log("name:", HTTPError.name, Base.name, Sub.name);
console.log("make:", Sub.make() instanceof Sub, Sub.make() instanceof Base);
console.log("tag:", Base.tag, Sub.tag, typeof Sub.tag);
