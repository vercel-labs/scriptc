// Property reads on function values: own properties, absent ones, and the
// builtin members a function answers itself.
function Component() {}
function Plain(a, b) {}
const arrow = (x) => x;
Component.defaultProps = { size: 1 };
Component.displayName = "Shown";
/** @param {any} type */
function show(type) {
  console.log(
    type.name,
    type.length,
    typeof type.prototype,
    type.displayName,
    JSON.stringify(type.defaultProps),
    type.$$typeof,
    typeof type.hasOwnProperty,
  );
}
show(Component);
show(Plain);
show(arrow);
console.log(Component.prototype.constructor === Component, Plain.prototype !== undefined);
Object.defineProperty(Plain, "computed", { get: () => "from getter" });
console.log(Plain.computed, Plain.missing);
class Widget {
  static kind = "widget";
}
console.log(Widget.kind, Widget.name, Widget.missing);
function named() {}
delete /** @type {any} */ (named).name;
console.log(JSON.stringify(named.name));
