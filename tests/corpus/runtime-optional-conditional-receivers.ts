// A captured binding whose storage can hold a hidden undefined (an
// out-of-bounds array read the checker types present) may flow through a
// logical or conditional expression that is itself a member receiver. The
// whole expression keeps the absent arm, so the operator decides its result
// exactly as Node does: an optional chain answers undefined, and a member
// read on an absent value throws Node's TypeError.
function trimTarget(values: string[], colon: number): string {
  let target = values[0];
  if (!target) return "";
  const read = () => (colon < 0 ? target : target.slice(0, colon)).trim();
  target = values[1];
  return read();
}

function lengthThroughLogical(values: string[], present: string): number | undefined {
  let value = values[0];
  if (!value) return undefined;
  const read = () => (present && value)?.length;
  value = values[1];
  return read();
}

function lengthThroughConditional(values: string[], present: boolean): number | undefined {
  let value = values[0];
  if (!value) return undefined;
  const read = () => (present ? value : value)?.length;
  value = values[1];
  return read();
}

function trimWithFallback(values: string[]): string {
  let value = values[0];
  if (!value) return "";
  const read = () => (value ?? "fallback").trim();
  value = values[1];
  return read();
}

console.log(trimTarget(["abc:def", "later"], 3));
console.log(trimTarget(["abc:def", "later"], -1));
console.log(lengthThroughLogical(["first", "second"], "yes"));
console.log(lengthThroughLogical(["first", "second"], ""));
console.log(lengthThroughConditional(["first", "second"], true));
console.log(lengthThroughConditional(["first", "second"], false));
console.log(trimWithFallback(["padded ", "next"]));

// The absent value still reaches the operator: an optional chain answers
// undefined and `??` supplies its default.
function absentThroughLogical(values: string[], present: string): number | undefined {
  let value = values[0];
  if (!value) return undefined;
  const read = () => (present && value)?.length;
  value = values[1];
  return read();
}
function absentWithFallback(values: string[]): string {
  let value = values[0];
  if (!value) return "";
  const read = () => (value ?? "fallback").trim();
  value = values[1];
  return read();
}
function throwing(values: string[], colon: number): string {
  let target = values[0];
  if (!target) return "";
  const read = () => (colon < 0 ? target : target.slice(0, colon)).trim();
  target = values[1];
  return read();
}

console.log(absentThroughLogical(["first"], ""));
console.log(absentWithFallback(["first"]));
try {
  console.log(throwing(["abc:def"], -1));
} catch (error) {
  const e = error as Error;
  console.log(e.name, e instanceof TypeError);
}
