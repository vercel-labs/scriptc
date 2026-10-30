// Object.defineProperty on a dynamic array's length: the value coerces with
// ToNumber, a shorter length deletes elements from the top down, a longer
// one leaves holes, a non-writable length refuses changes, and only false
// writable/enumerable/configurable are accepted. Node is the oracle.
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

attempt("descriptor", () => {
  const a = dyn([1, 2]);
  const d = Object.getOwnPropertyDescriptor(a, "length");
  return [d.value, d.writable, d.enumerable, d.configurable];
});

attempt("grow", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "length", { value: 4 });
  return [a.length, 1 in a, 3 in a, JSON.stringify(a), Object.keys(a)];
});

attempt("coerce", () => {
  const a = dyn([]);
  Object.defineProperty(a, "length", { value: "0x00B" });
  return [a.length, JSON.stringify(a)];
});

attempt("same-value", () => {
  const a = dyn([1, 2]);
  Object.defineProperty(a, "length", { value: 2 });
  return [a.length, Object.getOwnPropertyDescriptor(a, "length").writable];
});

attempt("empty-descriptor", () => {
  const a = dyn([]);
  Object.defineProperty(a, "length", {});
  a.length = 2;
  return [a.length, Object.getOwnPropertyDescriptor(a, "length").writable];
});

attempt("shrink", () => {
  const a = dyn([1, 2, 3]);
  Object.defineProperty(a, "length", { value: 1 });
  return [a.length, JSON.stringify(a), 1 in a, Object.keys(a)];
});

attempt("shrink-blocked", () => {
  const a = dyn([1, 2, 3]);
  Object.defineProperty(a, "1", { configurable: false });
  try {
    Object.defineProperty(a, "length", { value: 0 });
    return "OK";
  } catch (e) {
    return [e.name, e.message, a.length, JSON.stringify(a)];
  }
});

attempt("non-writable-length-element", () => {
  const a = dyn([]);
  Object.defineProperty(a, "length", { writable: false });
  try {
    Object.defineProperty(a, "0", { value: 1 });
    return "OK";
  } catch (e) {
    return [e.name, e.message, a.length];
  }
});

attempt("non-writable-length-push", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "length", { writable: false });
  try {
    a.push(2);
    return "OK";
  } catch (e) {
    return [e.name, e.message, a.length];
  }
});

attempt("non-writable-length-value", () => {
  const a = dyn([1, 2]);
  Object.defineProperty(a, "length", { writable: false });
  try {
    Object.defineProperty(a, "length", { value: 1 });
    return "OK";
  } catch (e) {
    return [e.name, e.message, a.length, JSON.stringify(a)];
  }
});

attempt("non-writable-length-writable", () => {
  const a = dyn([1]);
  Object.defineProperty(a, "length", { writable: false });
  try {
    Object.defineProperty(a, "length", { writable: true });
    return "OK";
  } catch (e) {
    return [e.name, e.message, Object.getOwnPropertyDescriptor(a, "length").writable];
  }
});

attempt("enumerable", () => Object.defineProperty(dyn([]), "length", { enumerable: true }));
attempt("configurable", () => Object.defineProperty(dyn([]), "length", { configurable: true }));

attempt("invalid", () =>
  ["-1", "1.5", "NaN", "4294967296", "abc"].map((text) => {
    const value = text === "NaN" ? NaN : Number(text);
    try {
      Object.defineProperty(dyn([]), "length", { value });
      return text + " OK";
    } catch (e) {
      return text + " " + e.name + " " + e.message;
    }
  }));

attempt("bigint", () => {
  try {
    Object.defineProperty(dyn([]), "length", { value: 1n });
    return "OK";
  } catch (e) {
    return [e.name, e.message];
  }
});

// The methods that write the length throw even when the length would not
// change; the ones that only write elements keep working.
attempt("read-only-length-methods", () => {
  const readOnly = (values) => {
    const a = values;
    Object.defineProperty(a, "length", { writable: false });
    return a;
  };
  const run = (name, f) => {
    try {
      return name + " " + JSON.stringify(f());
    } catch (e) {
      return name + " " + e.name + " " + e.message;
    }
  };
  const sort = readOnly(dyn([2, 1]));
  const fill = readOnly(dyn([1, 2])).fill(0);
  const copyWithin = readOnly(dyn([1, 2, 3])).copyWithin(0, 1);
  return [
    run("push0", () => readOnly(dyn([1])).push()),
    run("pop-empty", () => readOnly(dyn([])).pop()),
    run("shift-empty", () => readOnly(dyn([])).shift()),
    run("splice-noop", () => readOnly(dyn([])).splice(0, 0)),
    run("sort", () => sort.sort()),
    run("fill", () => fill),
    run("copyWithin", () => copyWithin),
    run("reverse", () => readOnly(dyn([2, 1])).reverse()),
  ];
});

// A non-configurable element refuses the delete a method makes first, and a
// method that grows a non-extensible array refuses its first new index.
attempt("attribute-writes", () => {
  const run = (name, f) => {
    try {
      return name + " " + JSON.stringify(f());
    } catch (e) {
      return name + " " + e.name + " " + e.message;
    }
  };
  const ro = (a) => {
    Object.defineProperty(a, "length", { writable: false });
    return a;
  };
  const freezeLength = (a) => {
    Object.defineProperty(a, "length", { writable: false });
    Object.preventExtensions(a);
    return a;
  };
  return [
    run("pop-nonconfigurable", () => {
      const a = dyn([1, 2]);
      Object.defineProperty(a, "1", { configurable: false });
      return ro(a).pop();
    }),
    run("pop-hole", () => {
      const a = dyn([]);
      a.length = 2;
      a[0] = 1;
      return ro(a).pop();
    }),
    run("ro-extensible-push", () => freezeLength(dyn([1])).push(2)),
    run("ro-extensible-push0", () => freezeLength(dyn([1])).push()),
    run("ro-extensible-pop", () => freezeLength(dyn([1, 2])).pop()),
    run("ro-extensible-unshift", () => freezeLength(dyn([1])).unshift(2)),
    run("ro-extensible-splice-insert", () => freezeLength(dyn([1])).splice(0, 0, 2)),
    run("ro-extensible-splice-delete", () => freezeLength(dyn([1, 2])).splice(0, 1)),
  ];
});
