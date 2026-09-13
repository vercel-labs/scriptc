// Both operands of instanceof evaluate before its result is chosen. A hole
// on the left behaves as undefined and returns false with a present class;
// a hole on the right still throws even when the left is missing.
class Item {}
class Child extends Item {}

const values: Item[] = [];
values[1] = new Item();
const classes: (typeof Item)[] = [];
classes[1] = Item;

const missingValue = values[0];
const presentClass = classes[1];
console.log(missingValue instanceof presentClass);

const missingClass = classes[0];
try {
  console.log(missingValue instanceof missingClass);
} catch (error) {
  console.log(error instanceof TypeError);
}
