const groups: number[][] = [];
groups.length = 1;
try {
  const [[value]] = groups;
  console.log("unexpected", value);
} catch (error) {
  if (error instanceof TypeError) console.log("nested-array", error.name);
}
try {
  for (const [value] of groups) console.log("unexpected", value);
} catch (error) {
  if (error instanceof TypeError) console.log("loop-array", error.name);
}
const objects: { value: number }[] = [];
objects.length = 1;
try {
  const [{ value }] = objects;
  console.log("unexpected", value);
} catch (error) {
  if (error instanceof TypeError) console.log("nested-object", error.name);
}
try {
  objects.find(({ value }) => value > 0);
} catch (error) {
  if (error instanceof TypeError) console.log("callback-object", error.name);
}
let calls = 0;
objects.map(({ value }) => {
  calls++;
  return value;
});
console.log("map-skips-hole", calls);
try {
  objects.toReversed().map(({ value }) => value);
} catch (error) {
  if (error instanceof TypeError) console.log("map-visits-undefined", error.name);
}
function head([value]: number[]): number {
  return value;
}
try {
  console.log(head(groups[0]));
} catch (error) {
  if (error instanceof TypeError) console.log("parameter-array", error.name);
}
const [defaultGroup = [9]] = groups;
console.log("default-array", defaultGroup[0]);
let assigned = 0;
try {
  [[assigned]] = groups;
} catch (error) {
  if (error instanceof TypeError) console.log("assignment-array", error.name, assigned);
}
