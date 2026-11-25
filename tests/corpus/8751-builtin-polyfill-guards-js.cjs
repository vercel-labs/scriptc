// The polyfill shapes of older packages, in a JavaScript source. Node 24 has
// every member tested here, so no polyfill runs; a compiled executable
// decides each guard the same way and does not refuse the write behind it.
var ran = 0;

Array.prototype.at ||
  (Array.prototype.at = function () {
    ran++;
    return "polyfill";
  });
Object.hasOwn ||
  Object.defineProperty(Object, "hasOwn", {
    value: function () {
      ran++;
      return "polyfill";
    },
  });
typeof String.prototype.padStart === "function" ||
  (String.prototype.padStart = function () {
    ran++;
    return "polyfill";
  });
Array.prototype.includes ??= function () {
  ran++;
  return "polyfill";
};
String.prototype.trimEnd =
  String.prototype.trimEnd ||
  function () {
    ran++;
    return "polyfill";
  };
if (!("flatMap" in Array.prototype))
  Array.prototype.flatMap = function () {
    ran++;
    return "polyfill";
  };
if (Array.prototype.findLast === undefined) {
  Array.prototype.findLast = function () {
    ran++;
    return "polyfill";
  };
}
if (typeof Promise.allSettled !== "function") {
  Promise.allSettled = function () {
    ran++;
    return "polyfill";
  };
} else {
  console.log("has allSettled");
}
if (Number.isInteger) {
  console.log("has isInteger");
} else {
  Number.isInteger = function () {
    ran++;
    return true;
  };
}
// A guard with an operand that runs for its effects: the operand runs, in
// order, and the polyfill behind the guard still never does.
var effects = [];
function effect(label, answer) {
  effects.push(label);
  return answer;
}
if (effect("and", true) && !Array.prototype.at) {
  Array.prototype.at = function () {
    ran++;
    return "polyfill";
  };
}
if (effect("or", false) || Array.prototype.flat) {
  effects.push("has flat");
} else {
  Array.prototype.flat = function () {
    ran++;
    return "polyfill";
  };
}
if (!Array.prototype.at && effect("never", true)) {
  Array.prototype.at = function () {
    ran++;
    return "polyfill";
  };
}
console.log(effects.join(","));
// A guard that returns early in front of the polyfill.
(function () {
  if (Array.prototype.flat) return;
  Array.prototype.flat = function () {
    ran++;
    return "polyfill";
  };
})();

console.log([1, 2, 3].at(-1), Object.hasOwn({ a: 1 }, "a"), "a".padStart(3, "-"));
console.log([1].includes(1), "a  ".trimEnd() + "|", [[1]].flatMap((x) => x).length);
console.log([1, 2].findLast((x) => x < 2), [[1], [2]].flat().length);
console.log(ran);

// A redefinition that changes only a member's attributes keeps the member.
Object.defineProperty(Math, "hypot", { enumerable: true });
Object.defineProperty(Math, "trunc", { value: Math.trunc, writable: false });
console.log(Object.keys(Math).join(","), Object.getOwnPropertyDescriptor(Math, "trunc").writable);
console.log(Math.trunc(1.5), Math.hypot(3, 4));
