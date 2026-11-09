// A member named like a builtin is the program's own function when the
// program defines it: it is called with the function's arguments, whatever
// its name. Only the builtins answer for what the arguments object is.

const ledger = {
  concat(entries) {
    return "ledger:" + entries.length;
  },
  stringify(entries) {
    return "ledger#" + entries.length;
  },
  isArray(entries) {
    return "ledger?" + entries.length;
  },
  toString() {
    return "ledger of " + this.length;
  },
};
function viaLiteral() {
  return [
    ledger.concat(arguments),
    ledger.stringify(arguments),
    ledger.isArray(arguments),
    ledger.toString.call(arguments),
  ].join(" ");
}
console.log(viaLiteral("oak", "elm", "ash"));

class Crate {
  constructor() {
    this.count = 0;
  }
  concat(more) {
    this.count += more.length;
    return this;
  }
  static concat(more) {
    return "crates:" + more.length;
  }
}
function viaClass() {
  return [new Crate().concat(arguments).count, Crate.concat(arguments)].join(" ");
}
console.log(viaClass("oak", "elm"));

// `call` and `apply` of the program's own function, and members that are
// themselves named `call` and `apply`.
const press = {
  concat(tail) {
    return "press:" + this.length + ":" + tail;
  },
};
const relay = {
  concat: {
    call(entries, tail) {
      return "call:" + entries.length + tail;
    },
    apply(entries, rest) {
      return "apply:" + entries.length + rest.length;
    },
  },
};
function viaCall() {
  return [
    press.concat.call(arguments, "end"),
    press.concat.apply(arguments, ["end"]),
    relay.concat.call(arguments, "!"),
    relay.concat.apply(arguments, [1, 2]),
  ].join(" ");
}
console.log(viaCall("oak", "elm", "ash"));

// A binding that shadows a global is the program's own, too.
function viaShadow() {
  const Array = {
    isArray(entries) {
      return "mine?" + entries.length;
    },
    prototype: {
      concat(tail) {
        return "mine:" + this.length + tail;
      },
    },
  };
  const Object = {
    prototype: {
      toString() {
        return "mine of " + this.length;
      },
    },
  };
  const JSON = {
    stringify(entries) {
      return "mine#" + entries.length;
    },
  };
  return [
    Array.isArray(arguments),
    Array.prototype.concat.call(arguments, "!"),
    Object.prototype.toString.call(arguments),
    JSON.stringify(arguments),
  ].join(" ");
}
console.log(viaShadow("oak", "elm"));

function viaShadowedParameter(Object) {
  return arguments instanceof Object;
}
console.log(viaShadowedParameter(Map, "oak"));

// Through an untyped receiver the member is whatever the value has.
function viaUntyped(tool) {
  return tool.concat(arguments);
}
console.log(viaUntyped(ledger, "oak"));

// The other arguments of such a call are evaluated like any call's.
let seen = 0;
function note(value) {
  seen += 1;
  return value;
}
function withEffects() {
  return ledger.concat(arguments, note("x")) + " " + press.concat.call(arguments, note("end"));
}
console.log(withEffects("oak", "elm"), seen);

// A function the program never calls builds like any other.
function unused() {
  return ledger.concat(arguments);
}
console.log(typeof unused);
