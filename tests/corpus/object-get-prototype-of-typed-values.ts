// Compiled values answer their real prototype too: a record is an ordinary
// object, a compiled array an ordinary array, and a class instance its
// class's prototype.
class Item {
  value = 1;
}
const record = { a: 1 };
const array = [1, 2];
const instance = new Item();
console.log(Object.getPrototypeOf(record) === Object.prototype);
console.log(Object.getPrototypeOf(array) === Array.prototype);
console.log(Object.getPrototypeOf(instance) === Item.prototype);
console.log(typeof Object.getPrototypeOf(record) === "object");
