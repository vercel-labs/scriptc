// Object.setPrototypeOf and Reflect.setPrototypeOf reject a prototype that is
// neither an object nor null before a proxy's setPrototypeOf trap runs, and a
// null or undefined receiver throws before either check.

const calls = [];
const proxied = new Proxy({}, {
  setPrototypeOf(target, proto) {
    calls.push("trap");
    return true;
  },
});

for (const proto of [1, "x", true, undefined]) {
  try {
    Object.setPrototypeOf(proxied, proto);
    console.log("set");
  } catch (error) {
    console.log(error.name, calls.length);
  }
  try {
    Reflect.setPrototypeOf(proxied, proto);
    console.log("set");
  } catch (error) {
    console.log(error.name, calls.length);
  }
}

// A receiver that is null or undefined is rejected before the prototype is.
try {
  Object.setPrototypeOf(null, 1);
} catch (error) {
  console.log(error.name);
}
try {
  Reflect.setPrototypeOf(undefined, 1);
} catch (error) {
  console.log(error.name);
}
try {
  Object.setPrototypeOf(7, 1);
} catch (error) {
  console.log(error.name);
}

// An accepted prototype still reaches the trap, and both operations answer the
// receiver.
const proto = { kind: "custom" };
console.log(Reflect.setPrototypeOf(proxied, proto), calls.join(","));
console.log(Object.setPrototypeOf(proxied, proto) === proxied, calls.join(","));
