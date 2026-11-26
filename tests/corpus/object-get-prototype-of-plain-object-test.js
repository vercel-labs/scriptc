// The plain-object test UI SDK's selects use to choose an empty container:
// a string and an array are not records, an object literal is.
var isRecord = (value) => !!value && Object.getPrototypeOf(value) === Object.prototype;
var noItems = [];
var noEntries = {};
var emptyLike = (other, missing) => Array.isArray(other) ? noItems : isRecord(other) ? noEntries : missing;
console.log(emptyLike({}, null) === noEntries);
console.log(emptyLike([], null) === noItems);
console.log(emptyLike("tab", "missing"));
console.log(emptyLike(null, "absent"));
console.log(isRecord(new Map()), isRecord(Object.create(null)), isRecord("x"));
