"use strict";
// A palette getter runs user code in the middle of a render. When that code
// inspects another value, the nested render starts its own circular
// bookkeeping and frame storage; the outer render must keep the seen/circular
// state and frame stack it was using, and keep rendering the same output it
// would without the reentrant call.
const { inspect } = require("node:util");

const deep = (n) => {
  let v = { leaf: true };
  for (let i = 0; i < n; i++) v = { v };
  return v;
};

const armed = (value, run) => ({
  enumerable: true,
  configurable: true,
  get() {
    if (!armed.used) {
      armed.used = true;
      run();
    }
    return value;
  },
});

// The circular prefix is styled through inspect.styles.special after the
// walk numbered the reference; a getter that inspects a deep value must not
// wipe that number.
{
  const a = { name: "a" };
  a.self = a;
  armed.used = false;
  Object.defineProperty(inspect.styles, "special", armed("cyan", () => {
    inspect(deep(64), { depth: 64, colors: true });
  }));
  console.log(JSON.stringify(inspect(a, { colors: true })));
}

// The same getter inspecting a value that is itself circular.
{
  const b = { name: "b" };
  b.self = b;
  armed.used = false;
  Object.defineProperty(inspect.styles, "special", armed("cyan", () => {
    inspect(b, { colors: true });
  }));
  console.log(JSON.stringify(inspect(b, { colors: true })));
}

// Two circular owners in one render keep their own numbers.
{
  const one = { name: "one" };
  const two = { name: "two" };
  one.self = one;
  two.other = { back: two };
  armed.used = false;
  Object.defineProperty(inspect.styles, "special", armed("cyan", () => {
    inspect(deep(32), { depth: 32, colors: true });
  }));
  console.log(JSON.stringify(inspect({ one, two }, { colors: true })));
}

// Without a reentrant getter the same renders are unchanged.
{
  const c = { name: "c" };
  c.self = c;
  console.log(JSON.stringify(inspect(c, { colors: true })));
}
