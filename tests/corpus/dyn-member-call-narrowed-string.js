// A member read on a checked-dynamic binding the checker narrowed to a
// string takes the static member lowering: the string's own length, a
// substring, and a switch-guarded read all answer without the dynamic
// class helper ever receiving a typed (narrowed) receiver.
//
// Every `.length` here was an SC9001 ICE (call %dyn.class.property.N arg 0:
// expected dyn, got string): the narrowed value reached the dynamic helper.
function sizeOf(target) {
  if (typeof target === "string") return target.length;
  if (Array.isArray(target)) return target.length;
  return 0;
}

function trimEnd(str, chars) {
  if (chars === void 0) return str.trimEnd();
  let endIndex = str.length;
  switch (typeof chars) {
    case "string":
      if (chars.length !== 1) throw new Error("one character");
      while (endIndex > 0 && str[endIndex - 1] === chars) endIndex--;
      break;
    case "object":
      while (endIndex > 0 && chars.includes(str[endIndex - 1])) endIndex--;
      break;
  }
  return str.substring(0, endIndex);
}

function widthOf(input) {
  if (typeof input !== "string" || input.length === 0) return 0;
  return input.slice(0, 1).length;
}

console.log(sizeOf("abcdef"), sizeOf([1, 2, 3]), sizeOf(42), sizeOf(null));
console.log(trimEnd("hello---", "-"), trimEnd("hello...", ["."]), trimEnd(" padded "));
console.log(widthOf("abc"), widthOf(""));
