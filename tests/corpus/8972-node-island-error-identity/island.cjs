const lib = require("./lib.ts");

class Local extends Error {}

lib.identity(TypeError, () => {
  null.property;
});
lib.identity(ReferenceError, () => {
  missingName;
});
lib.identity(TypeError, () => {
  throw new RangeError("range");
});
lib.identity(RangeError, () => {
  throw new Local("local");
});
lib.identity(Local, () => {
  throw new Local("local");
});
console.log(new Local("built").constructor.name, Local.name);

undeclaredGlobal = 1;
