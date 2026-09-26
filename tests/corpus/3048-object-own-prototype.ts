const record = { a: 1, b: "two" };
const key = "a";
console.log(
  Object.prototype.hasOwnProperty.call(record, key),
  Object.prototype.hasOwnProperty.call(record, "missing"),
  Object.prototype.propertyIsEnumerable.call(record, "b"),
  Object.prototype.propertyIsEnumerable.call(record, "toString"),
);
console.log(record.hasOwnProperty(key), record.propertyIsEnumerable("b"), record.hasOwnProperty("toString"));

const sparse = [10, , undefined, 40];
console.log(
  Object.prototype.hasOwnProperty.call(sparse, "0"),
  Object.prototype.hasOwnProperty.call(sparse, "1"),
  Object.prototype.hasOwnProperty.call(sparse, "2"),
  Object.prototype.propertyIsEnumerable.call(sparse, "2"),
  Object.prototype.hasOwnProperty.call(sparse, "length"),
  Object.prototype.propertyIsEnumerable.call(sparse, "length"),
  Object.prototype.hasOwnProperty.call(sparse, "01"),
);
const variableIndex = "2";
const absentIndex = "1";
const fractionalIndex = "2.5";
console.log(
  Object.prototype.hasOwnProperty.call(sparse, variableIndex),
  Object.prototype.hasOwnProperty.call(sparse, absentIndex),
  Object.prototype.propertyIsEnumerable.call(sparse, variableIndex),
  Object.prototype.hasOwnProperty.call(sparse, fractionalIndex),
  Object.prototype.hasOwnProperty.call(sparse, -1),
  Object.prototype.hasOwnProperty.call(sparse, -0),
);
console.log(sparse.hasOwnProperty(variableIndex), sparse.propertyIsEnumerable(variableIndex), sparse.propertyIsEnumerable("length"));

const text = "A\ud834\udd1eB";
console.log(
  Object.prototype.hasOwnProperty.call(text, "length"),
  Object.prototype.propertyIsEnumerable.call(text, "length"),
  Object.prototype.hasOwnProperty.call(text, "2"),
  Object.prototype.propertyIsEnumerable.call(text, "3"),
  Object.prototype.hasOwnProperty.call(text, "4"),
);
const variableLength = "length";
const variableTextIndex = "2";
console.log(
  Object.prototype.hasOwnProperty.call(text, variableLength),
  Object.prototype.propertyIsEnumerable.call(text, variableLength),
  Object.prototype.hasOwnProperty.call(text, variableTextIndex),
  Object.prototype.hasOwnProperty.call(text, fractionalIndex),
  Object.prototype.hasOwnProperty.call(text, "-1"),
);
console.log(text.hasOwnProperty(variableLength), text.propertyIsEnumerable(variableTextIndex));
console.log(
  Object.prototype.hasOwnProperty.call(7, "valueOf"),
  Object.prototype.propertyIsEnumerable.call(false, "0"),
  Object.prototype.hasOwnProperty.call(JSON.parse('{"a":1}'), "a"),
  Object.prototype.hasOwnProperty.call(JSON.parse('[1,null]'), "length"),
);
const parsedText = JSON.parse('"A\\ud834\\udd1eB"');
console.log(
  Object.prototype.hasOwnProperty.call(parsedText, "length"),
  Object.prototype.hasOwnProperty.call(parsedText, "0"),
  Object.prototype.hasOwnProperty.call(parsedText, "1"),
  Object.prototype.hasOwnProperty.call(parsedText, "2"),
  Object.prototype.hasOwnProperty.call(parsedText, "3"),
  Object.prototype.hasOwnProperty.call(parsedText, "4"),
  Object.prototype.hasOwnProperty.call(parsedText, "01"),
);
const parsedArray = JSON.parse("[4,5]");
console.log(
  Object.prototype.hasOwnProperty.call(parsedArray, "1"),
  Object.prototype.hasOwnProperty.call(parsedArray, "2"),
  Object.prototype.hasOwnProperty.call(parsedArray, "18446744073709551617"),
);
const boxedBytes: unknown = new Uint8Array([7, 8]);
console.log(
  Object.prototype.hasOwnProperty.call(boxedBytes, "1"),
  Object.prototype.hasOwnProperty.call(boxedBytes, "length"),
);

const order: string[] = [];
const changing: { value?: number } = {};
function receiver() { order.push("receiver"); return changing; }
function property() { order.push("key"); return "value"; }
function extra() { order.push("extra"); changing.value = 9; return 0; }
// @ts-ignore: Function.prototype.call accepts surplus JavaScript arguments.
console.log(Object.prototype.hasOwnProperty.call(receiver(), property(), extra()), order.join(","));
try {
  // @ts-ignore: Function.prototype.call accepts surplus JavaScript arguments.
  Object.prototype.hasOwnProperty.call(null, property(), extra());
} catch (error) {
  console.log((error as Error).name, order.join(","));
}
