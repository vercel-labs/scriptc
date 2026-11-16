// @disallow-code-generation
// `new (fn.constructor)(...)` reads the member the call form reads and
// constructs the value it answers: a function's own `constructor` property
// builds that function, the inherited Function constructor refuses like
// `new Function(...)` after converting each argument to a string in order,
// and a nullish receiver throws the property-read TypeError before any
// argument runs.
function report(label, run) {
  try {
    run();
    console.log(label, "no throw");
  } catch (error) {
    console.log(label, error.name + ": " + error.message);
  }
}

const expression = function () {
  return 1;
};
const arrow = () => 2;
function declaration() {
  return 3;
}
class Example {
  method() {
    return 4;
  }
}
const instance = new Example();

report("expression", () => {
  new (expression.constructor)("return 1");
});
report("arrow", () => {
  new (arrow.constructor)("return 1");
});
report("declaration", () => {
  new (declaration.constructor)("return 1");
});
report("class", () => {
  new (Example.constructor)("return 1");
});
report("method", () => {
  new (instance.method.constructor)("return 1");
});
report("bound", () => {
  new (expression.bind(null).constructor)("return 1");
});
report("element access", () => {
  new (expression["constructor"])("return 1");
});

// The Function constructor converts every argument to a string first, so a
// toString runs before the refusal.
const converted = [];
report("conversion", () => {
  new (expression.constructor)(
    {
      toString() {
        converted.push("first");
        return "a";
      },
    },
    {
      toString() {
        converted.push("second");
        return "b";
      },
    },
  );
});
console.log(converted.join(","));

// A function the program gives its own `constructor` builds that one.
class Box {
  constructor(value) {
    this.value = value;
  }
}
function Legacy(value) {
  this.value = value;
}
const returnsObject = function (value) {
  return { value };
};
/** @returns {() => number} */
function make() {
  const made = () => 1;
  made.constructor = Box;
  return made;
}
/** @returns {() => number} */
function makeLegacy() {
  const made = () => 1;
  made.constructor = Legacy;
  return made;
}
/** @returns {() => number} */
function makeReturning() {
  const made = () => 1;
  made.constructor = returnsObject;
  return made;
}
/** @returns {() => number} */
function makeArrow() {
  const made = () => 1;
  made.constructor = (value) => value;
  return made;
}
report("own class", () => {
  const box = new (make().constructor)(2);
  console.log(box.value, box instanceof Box);
});
report("own function", () => {
  console.log(new (makeLegacy().constructor)(3).value);
});
report("own returning function", () => {
  console.log(new (makeReturning().constructor)(4).value);
});
report("own arrow", () => {
  new (makeArrow().constructor)(5);
});
report("own class without arguments", () => {
  const box = new (make().constructor)();
  console.log(String(box.value), box instanceof Box);
});

// The receiver is read first, then the arguments, in order.
const order = [];
function receiver() {
  order.push("receiver");
  return make();
}
function argument(tag) {
  order.push(tag);
  return 1;
}
report("evaluation order", () => {
  new (receiver().constructor)(argument("first"), argument("second"));
});
console.log(order.join(","));

// A runtime-length spread determines the argument list, still after the read.
const spread = [6, 7];
report("spread", () => {
  console.log(new (makeLegacy().constructor)(...spread).value);
});

// A nullish receiver throws the property-read TypeError before any argument
// runs, and the member is not read a second time.
const skipped = [];
function recorded(tag) {
  skipped.push(tag);
  return "return 5";
}
/** @returns {(() => number) | undefined} */
function maybe() {
  return undefined;
}
/** @returns {(() => number) | null} */
function nothing() {
  return null;
}
report("undefined receiver", () => {
  new (maybe().constructor)(recorded("never"));
});
report("null receiver", () => {
  new (nothing().constructor)(recorded("never"));
});
console.log(skipped.join(",") || "(none)");
