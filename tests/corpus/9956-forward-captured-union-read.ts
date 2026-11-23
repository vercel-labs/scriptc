// A closure created above a union-typed binding captures it first. The
// binding admits no undefined, so the captured reads keep its declared
// union exactly: a typeof guard narrows the string arm and the member read
// runs on it, and the number arm answers without one.
const describe = (): string => {
  if (typeof label !== "string") return `number:${String(label)}`;
  return `string:${label.length}:${label.trim()}`;
};

let label: string | number = "  abc  ";
console.log(describe());
label = 42;
console.log(describe());
