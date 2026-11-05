// An element of an optional-element array literal that comes from an
// untyped value: undefined is part of the element type, so the literal
// keeps it present and serializes it as null, while a value of the
// element type passes through unchanged.
function nums(value: any): Array<number | undefined> {
  return [value, 1];
}
function names(value: any): Array<string | undefined> {
  return [value, "a"];
}
function flags(value: any): Array<boolean | undefined> {
  return [value, true];
}
console.log(JSON.stringify(nums(undefined)));
console.log(JSON.stringify(names(undefined)));
console.log(JSON.stringify(flags(undefined)));
console.log(nums(undefined).length, names(undefined).length, flags(undefined).length);
console.log(JSON.stringify(nums(2)));
console.log(JSON.stringify(names("s")));
console.log(JSON.stringify(flags(false)));
const held: any = undefined;
console.log(JSON.stringify(nums(held)), JSON.stringify(names(held)), JSON.stringify(flags(held)));
const list = nums(undefined);
list.push(3);
console.log(JSON.stringify(list), list.length, list[0] === undefined);
