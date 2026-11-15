"use strict";
// util.inspect of a sparse dynamic array whose number-style palette getter
// changes the array while it is being rendered. Growing reallocates the
// array's presence storage, and shrinking releases the elements past the new
// length, so an inspection that kept either across a render would read what
// the callback freed. The renderer re-reads the live value, and the output
// follows Node: entries the array no longer has are not printed, a shortened
// array stops after its last live entry, and a mutation that restores the
// array renders the same entries as an inspection that never ran the getter.
const util = require("node:util");

const style = (read) => Object.defineProperty(util.inspect.styles, "number", {
  configurable: true,
  get: read,
});

const sparse = () => {
  const value = JSON.parse("[1,2,3]");
  value[5] = 6;
  return value;
};

{
  // Shrunk to empty by the getter for the first number.
  const value = sparse();
  style(() => {
    value.length = 0;
    return "cyan";
  });
  console.log("shrink to empty", util.inspect(value, { colors: true }));
}

{
  // Shrunk to a shorter length: the entries past it are gone.
  const value = sparse();
  style(() => {
    value.length = 2;
    return "cyan";
  });
  console.log("shrink to two", util.inspect(value, { colors: true }));
}

{
  // Grown at the end and restored exactly: the presence storage moved, the
  // visible array is the one the inspection started with.
  const value = sparse();
  style(() => {
    if (value.length === 6) value.push(7, 8, 9, 10, 11, 12);
    value.length = 6;
    value[0] = 1;
    value[1] = 2;
    value[2] = 3;
    delete value[3];
    delete value[4];
    value[5] = 6;
    return "cyan";
  });
  console.log("grow and restore", util.inspect(value));
}

{
  // The same callback inside an object, after which the render continues with
  // the object's next property.
  const value = sparse();
  const holder = { value, tag: "kept" };
  let calls = 0;
  style(() => {
    calls += 1;
    if (calls === 1) value.length = 1;
    return "cyan";
  });
  console.log("nested shrink", util.inspect(holder, { colors: true }));
  console.log("nested calls", calls, value.length);
}

{
  // A dense array takes no presence storage; growth during its render does
  // not add entries to the output, as Node's array formatter bounds the walk
  // by the length it saw at the start.
  const value = JSON.parse("[1,2,3]");
  style(() => {
    if (value.length === 3) value.push(4, 5);
    return "cyan";
  });
  console.log("dense grow", util.inspect(value));
}
