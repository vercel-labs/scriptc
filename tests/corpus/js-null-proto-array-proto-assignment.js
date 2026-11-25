// An array whose [[Prototype]] is null reaches no `__proto__` accessor, so
// assigning the name adds an own data property, exactly as it does for a
// null-prototype object.
const array = JSON.parse("[1, 2]");
Object.setPrototypeOf(array, null);
console.log("array proto", Object.getPrototypeOf(array) === null, array.__proto__ === undefined);
console.log("array no accessor", "__proto__" in array, Object.hasOwn(array, "__proto__"));
const replacement = { marker: 1 };
array.__proto__ = replacement;
console.log("array own", array.__proto__ === replacement, Array.isArray(array));
console.log("array own key", Object.hasOwn(array, "__proto__"), Object.getPrototypeOf(array) === null);

// A later write updates that same own property.
const second = { marker: 2 };
array.__proto__ = second;
console.log("array update", array.__proto__ === second);

// A null-prototype object answers the same way.
const object = Object.create(null);
object.__proto__ = replacement;
console.log("object own", object.__proto__ === replacement, Object.getPrototypeOf(object) === null);

// A prototype that reaches Object.prototype keeps the accessor.
const plain = JSON.parse("[3]");
plain.__proto__ = replacement;
console.log(
  "plain",
  Object.getPrototypeOf(plain) === replacement,
  Object.prototype.hasOwnProperty.call(plain, "__proto__"),
);
