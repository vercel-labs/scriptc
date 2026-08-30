// 2714 console.error/warn with Error and any via string coercion or inspect
console.error(String(new TypeError("bad type")));
console.warn(String(new RangeError("out of range")));
console.error(String(new Error("plain error")));

function makeAny(): any {
  return { x: 1, y: "hello" };
}
const anyVal: any = makeAny();
console.error(anyVal);
console.warn(anyVal);

const unknownVal: unknown = new TypeError("unknown error");
console.error(String(unknownVal));
console.warn(String(unknownVal));

// any with primitives should also go through string coercion/inspect
const anyNum: any = 42;
console.error(anyNum);
console.warn(anyNum);

console.error("mixed", String(new TypeError("mix")), anyVal);
console.warn("warn mixed", anyNum, String(unknownVal));

// direct any string
const anyStr: any = "any string";
console.error(anyStr);
console.warn(anyStr);
