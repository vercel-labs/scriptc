// `catch ([a, b])` / `catch ({ name, message })`: the caught value is the
// exception cell's checked-dynamic view, and the pattern binds through the
// same runtime steps a checked-dynamic source takes — GetIterator for an
// array pattern, RequireObjectCoercible and keyed reads for an object one.
var out = [];
try {
  throw [1, 2];
} catch ([a, b]) {
  out.push("array " + a + " " + b);
}
try {
  throw { x: 23, y: "s" };
} catch ({ x, y: alias }) {
  out.push("object " + x + " " + alias);
}
try {
  throw new RangeError("boom");
} catch ({ name, message }) {
  out.push("error " + name + " " + message);
}
// A default fires on the undefined read, and a position past the end binds
// undefined.
try {
  throw [undefined];
} catch ([d = 7, gone]) {
  out.push("default " + String(d) + " " + String(gone));
}
// A nested object pattern over the thrown record.
try {
  throw { inner: { deep: "D" } };
} catch ({ inner: { deep } }) {
  out.push("nested " + deep);
}
console.log(out.join("\n"));

// A pattern that cannot bind the thrown value throws a TypeError whose
// class is observable.
function probe(f) {
  try {
    f();
    return "no throw";
  } catch (e) {
    if (e instanceof TypeError) return "TypeError";
    if (e instanceof Error) return "Error";
    return "other";
  }
}
console.log(probe(function () {
  try {
    throw 42;
  } catch ([v]) {
    void v;
  }
}));
console.log(probe(function () {
  try {
    throw null;
  } catch ({ p }) {
    void p;
  }
}));
console.log(probe(function () {
  try {
    throw undefined;
  } catch ({}) {
    // nothing to bind
  }
}));
console.log(probe(function () {
  try {
    throw "str";
  } catch ({ length }) {
    void length;
  }
}));

// The bindings are ordinary mutables: a write in the handler is visible to
// the rest of the handler and dies with it.
var last = 0;
try {
  throw [11, 22];
} catch ([p, q]) {
  p = q;
  last = p;
}
console.log("mutated", last);

// A catch pattern inside a loop rebinds per throw.
var sums = [];
var thrownValues = [[1, 2], [3, 4], [5, 6]];
for (var i = 0; i < thrownValues.length; i++) {
  try {
    throw thrownValues[i];
  } catch ([l, r]) {
    sums.push(l + r);
  }
}
console.log(sums.join(","));

// A defaulted first property is read once: its getter runs one time, and a
// nullish thrown value throws the read's TypeError.
var reads = 0;
try {
  throw {
    get first() {
      reads++;
      return reads === 1 ? "once" : "again";
    },
  };
} catch ({ first = "fallback", other = "none" }) {
  console.log("getter", first, other, reads);
}
console.log(probe(function () {
  try {
    throw null;
  } catch ({ p = 1 }) {
    void p;
  }
}));

// Each execution of the clause makes new bindings, so closures made in
// different executions keep their own values.
function collect() {
  var readers = [];
  for (var k = 0; k < 3; k++) {
    try {
      throw { value: k * 10 };
    } catch ({ value }) {
      readers.push(function () {
        return value;
      });
    }
  }
  return readers.map(function (read) {
    return read();
  });
}
console.log(collect().join(","));
var topReaders = [];
for (var t = 0; t < 3; t++) {
  try {
    throw [t + 1];
  } catch ([item]) {
    topReaders.push(function () {
      return item;
    });
  }
}
console.log(topReaders.map(function (read) {
  return read();
}).join(","));
console.log("done");
