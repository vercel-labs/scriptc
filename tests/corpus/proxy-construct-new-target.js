// Reflect.construct's newTarget on the dynamic tier. A written `undefined` or
// `null` third argument is checked like any other value instead of falling
// back to the two-argument form, a proxy without a construct trap forwards
// newTarget to its target, and a proxy over a value that is not a constructor
// is not one either, so its construct trap never runs. A builtin constructor
// takes the forwarded newTarget's prototype the same way a function does, and
// a proxy over a builtin method is not a constructor.

function Point(x) {
  this.x = x;
}
Point.prototype.describe = function () {
  return "point:" + this.x;
};

const plain = Reflect.construct(Point, [1]);
console.log(plain instanceof Point, plain.describe());

for (const newTarget of [undefined, null, 7]) {
  try {
    Reflect.construct(Point, [1], newTarget);
    console.log("constructed");
  } catch (error) {
    console.log(error.name);
  }
}

// The target, then newTarget, then the argument list.
const order = [];
const argsList = {
  get length() {
    order.push("length");
    return 0;
  },
};
const arrow = () => {};
try {
  Reflect.construct(arrow, argsList);
} catch (error) {
  console.log(error.name, order.length);
}
try {
  Reflect.construct(Point, argsList, arrow);
} catch (error) {
  console.log(error.name, order.length);
}
try {
  Reflect.construct({}, argsList, Point);
} catch (error) {
  console.log(error.name, order.length);
}
Reflect.construct(Point, argsList);
console.log(order.join(","));

// A proxy without a construct trap constructs through its target with the
// proxy as newTarget: the target reads `prototype` through the proxy, so the
// get trap runs and the instance takes that prototype.
const proto = { kind: "custom" };
const reads = [];
const forward = new Proxy(function Greeting(word) {
  this.word = word;
}, {
  get(target, key, receiver) {
    if (key === "prototype") {
      reads.push("prototype");
      return proto;
    }
    return Reflect.get(target, key, receiver);
  },
});
const built = new forward("hi");
console.log(Object.getPrototypeOf(built) === proto, built.word, reads.join(","));
const viaReflect = Reflect.construct(forward, ["there"]);
console.log(Object.getPrototypeOf(viaReflect) === proto, viaReflect.word, reads.join(","));

// A proxy over an arrow function or a method is not a constructor.
const calls = [];
const overArrow = new Proxy(() => {}, {
  construct() {
    calls.push("construct");
    return {};
  },
});
try {
  Reflect.construct(overArrow, []);
} catch (error) {
  console.log(error.name, calls.length);
}
try {
  new overArrow();
} catch (error) {
  console.log(error.name, calls.length);
}
const overMethod = new Proxy({ m() {} }.m, {
  construct() {
    calls.push("construct");
  },
});
try {
  Reflect.construct(overMethod, []);
} catch (error) {
  console.log(error.name, calls.length);
}
console.log(calls.length);

// A builtin constructor target reads the forwarded newTarget's `prototype`
// too: Array builds an array whose prototype is that object, and a
// newTarget whose `prototype` is not an object keeps Array.prototype.
function Marker() {}
const overArray = new Proxy(Array, {});
const viaMarker = Reflect.construct(overArray, [1, 2], Marker);
console.log(
  Object.getPrototypeOf(viaMarker) === Marker.prototype,
  Array.isArray(viaMarker),
  viaMarker.length,
  viaMarker[1],
);
const primitivePrototype = new Proxy(Marker, {
  get(target, key, receiver) {
    if (key === "prototype") return 7;
    return Reflect.get(target, key, receiver);
  },
});
const viaPrimitive = Reflect.construct(overArray, [3], primitivePrototype);
console.log(Object.getPrototypeOf(viaPrimitive) === Array.prototype, viaPrimitive.length);
const builtArray = new overArray(4);
console.log(Array.isArray(builtArray), builtArray.length);
const overMarker = new Proxy(Marker, {});
const viaWrapped = Reflect.construct(overArray, [5], overMarker);
console.log(Object.getPrototypeOf(viaWrapped) === Marker.prototype, viaWrapped.length);

// A proxy over a builtin method is not a constructor either.
const overMax = new Proxy(Math.max, {
  construct() {
    calls.push("construct");
    return {};
  },
});
try {
  Reflect.construct(overMax, [1, 2]);
} catch (error) {
  console.log(error.name, calls.length);
}
try {
  new overMax();
} catch (error) {
  console.log(error.name, calls.length);
}
const overTrim = new Proxy("text".trim, {});
try {
  Reflect.construct(overTrim, []);
} catch (error) {
  console.log(error.name);
}
