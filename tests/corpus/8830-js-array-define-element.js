// Object.defineProperty on a dynamic array's elements: a data descriptor
// stores the value with its attributes, a redefine keeps the attributes it
// omits and validates a non-configurable descriptor, and an index at or
// beyond length grows the array with holes. Node is the oracle.
function attempt(name, f) {
  try {
    console.log(name, "OK", JSON.stringify(f()));
  } catch (e) {
    console.log(name, "THROW", e.name, e.message);
  }
}

// The arrays arrive from a parameter whose type is not known, so every
// operation runs against a checked-dynamic value.
/** @param {any} value */
function dyn(value) {
  return value;
}

// A new element stores every attribute the descriptor names and the ones it
// omits default to false.
attempt("new-index", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "3", { value: "x", writable: true, enumerable: false, configurable: true });
  const d = Object.getOwnPropertyDescriptor(a, "3");
  return [a.length, JSON.stringify(a), Object.keys(a), 3 in a, 2 in a, d.value, d.writable, d.enumerable, d.configurable];
});

// A data descriptor that names only the value keeps the prior attributes.
attempt("redefine-value-only", () => {
  const a = dyn([1, 2]);
  Object.defineProperty(a, "0", { value: 7 });
  const d = Object.getOwnPropertyDescriptor(a, "0");
  return [a[0], d.writable, d.enumerable, d.configurable, JSON.stringify(a)];
});

// A non-enumerable element stays a present index: `in`, length and reads see
// it, Object.keys and JSON do not.
attempt("non-enumerable", () => {
  const a = dyn([1, 2]);
  Object.defineProperty(a, "0", { enumerable: false });
  return [Object.keys(a), JSON.stringify(a), a.length, 0 in a, a[0], a.join("-")];
});

// Attributes are inherited from the prior descriptor, so an omitted
// enumerable keeps the element non-enumerable.
attempt("inherit-enumerable", () => {
  const a = dyn([1, 2]);
  Object.defineProperty(a, "1", { enumerable: false });
  Object.defineProperty(a, "1", { value: 5 });
  const d = Object.getOwnPropertyDescriptor(a, "1");
  return [Object.keys(a), JSON.stringify(a), d.value, d.enumerable];
});

// A non-configurable element refuses a changed value, a changed attribute,
// and a redefinition, but accepts the same value.
attempt("non-configurable", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "0", { value: 2, writable: true, enumerable: true, configurable: false });
  const same = (() => {
    try {
      Object.defineProperty(a, "0", { value: 2 });
      return "same-value OK";
    } catch (e) {
      return e.message;
    }
  })();
  const different = (() => {
    try {
      Object.defineProperty(a, "0", { value: 3 });
      return "different-value OK";
    } catch (e) {
      return e.message;
    }
  })();
  const writable = (() => {
    try {
      Object.defineProperty(a, "0", { writable: false });
      return "writable OK";
    } catch (e) {
      return e.message;
    }
  })();
  const enumerable = (() => {
    try {
      Object.defineProperty(a, "0", { enumerable: false });
      return "enumerable OK";
    } catch (e) {
      return e.message;
    }
  })();
  return [same, different, writable, enumerable, a[0]];
});

// A non-writable element keeps its value through an assignment.
attempt("writable-false", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "0", { writable: false });
  let write = "written";
  try {
    a[0] = 9;
  } catch (e) {
    write = e.name + " " + e.message;
  }
  Object.defineProperty(a, "0", { value: 4, writable: true, enumerable: true, configurable: true });
  return [write, a[0], Object.getOwnPropertyDescriptor(a, "0").writable];
});

// A frozen array refuses a new element and a value change.
attempt("frozen", () => {
  const a = dyn([1]);
  Object.freeze(a);
  const added = (() => {
    try {
      Object.defineProperty(a, "1", { value: 2 });
      return "added OK";
    } catch (e) {
      return e.message;
    }
  })();
  const changed = (() => {
    try {
      Object.defineProperty(a, "0", { value: 2 });
      return "changed OK";
    } catch (e) {
      return e.message;
    }
  })();
  const same = (() => {
    try {
      Object.defineProperty(a, "0", { value: 1 });
      return "same OK";
    } catch (e) {
      return e.message;
    }
  })();
  return [added, changed, same, a.length, JSON.stringify(a)];
});

// An index define on a non-extensible array with room in its length still
// refuses, because the index is a new property.
attempt("non-extensible", () => {
  const a = dyn([1]);
  a.length = 3;
  Object.preventExtensions(a);
  try {
    Object.defineProperty(a, "2", { value: 2 });
    return "OK";
  } catch (e) {
    return [e.name, e.message, a.length];
  }
});

// A descriptor that is neither a data nor an accessor descriptor with a
// value and attributes runs the same validation as defineProperty.
attempt("empty-descriptor", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "0", {});
  const d = Object.getOwnPropertyDescriptor(a, "0");
  return [a[0], d.writable, d.enumerable, d.configurable];
});
