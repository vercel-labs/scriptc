// A polyfill guard is decided without evaluating its test only when nothing
// in the test runs. One case per position an operand can sit in: each runs
// under Node, so each runs in the compiled program. The member is one the
// program never calls, so the guarded writes compile.
let calls = 0;
function note(label: string): number {
  calls++;
  console.log("note", label);
  return calls;
}

// A computed member key.
if (!Array.prototype[(note("key"), "findLast")]) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}
Array.prototype[(note("assigned key"), "findLast")] ||= function () {
  return undefined;
};

// A comma in front of the test, and in front of the member.
if ((note("comma test"), !Array.prototype.findLast)) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}
if (typeof (note("comma typeof"), Array.prototype.findLast) !== "function") {
  Array.prototype.findLast = function () {
    return undefined;
  };
}
(note("comma statement"), Array.prototype.findLast) ||
  (Array.prototype.findLast = function () {
    return undefined;
  });

// The argument of a call, and the key of `in`.
if (!Array.prototype.hasOwnProperty((note("argument"), "findLast"))) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}
if (!(((note("in key"), "findLast") as string) in Array.prototype)) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}

// An operand of `&&` and `||` that the answer does not depend on.
if (note("and") > 100 && !Array.prototype.findLast) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}
if (Array.prototype.findLast === void 0 || note("or") > 100) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}

// The value whose prototype is read.
if (!Object.getPrototypeOf([note("prototype")]).findLast) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}

// An alias read before its declaration has run: Node throws.
function early(): void {
  if (!proto.findLast) {
    Array.prototype.findLast = function () {
      return undefined;
    };
  }
}
function earlyStatement(): void {
  proto.findLast ||
    (Array.prototype.findLast = function () {
      return undefined;
    });
}
for (const probe of [early, earlyStatement]) {
  try {
    probe();
    console.log("no throw");
  } catch (e) {
    console.log("threw", e instanceof ReferenceError);
  }
}
const proto = Array.prototype;
// After it, the alias is the object, and the test has nothing to run.
if (!proto.findLast) {
  Array.prototype.findLast = function () {
    return undefined;
  };
}
const late = (): void => {
  if (!proto.findLast) {
    Array.prototype.findLast = function () {
      return undefined;
    };
  }
};
late();

console.log(calls);
