// Deprecation getters installed on a constructor function's prototype
// under names only the loop knows (React's defineDeprecationWarning), beside
// an ordinary prototype method.
"use strict";

function Component() {}
const deprecated = ["menu", "focus"];
for (let i = 0; i < deprecated.length; i++) {
  const methodName = deprecated[i];
  Object.defineProperty(Component.prototype, methodName, {
    get: function () {
      return "deprecated:" + methodName;
    },
    configurable: true,
  });
}
Component.prototype.normal = function () {
  return "ok";
};

const component = new Component();
console.log(component.menu, component.focus, component.normal());
console.log(Object.getOwnPropertyNames(Component.prototype).sort().join(","));
console.log(Object.getOwnPropertyDescriptor(Component.prototype, "menu").enumerable);
