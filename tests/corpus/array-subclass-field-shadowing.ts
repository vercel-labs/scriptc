// An own field whose name is an Array method's shadows the prototype method
// on the instance, as any class field does: a call written on a value typed
// as a plain array runs the field's function, not the builtin, and the
// array's elements and length stay as they were.
class Shadowed extends Array<number> {
  push = (value: number): number => {
    console.log("field push", value);
    return 41;
  };

  pop = (): number => {
    console.log("field pop");
    return 7;
  };

  forEach = (
    cb: (value: number, index: number, array: number[]) => void,
    thisArg?: unknown,
  ): void => {
    console.log("field forEach");
    cb(100, 0, this as unknown as number[]);
  };
}

const shadowed = new Shadowed();
shadowed[0] = 1;
shadowed[1] = 2;

const base: number[] = shadowed;
console.log("push", base.push(9), shadowed.length, shadowed.join(","));
console.log("pop", base.pop(), shadowed.length, shadowed.join(","));
const seen: number[] = [];
base.forEach((value, index) => seen.push(value + index));
console.log("forEach", seen.join(","), shadowed.length);

// The same fields through the subclass type.
console.log("typed push", shadowed.push(8), shadowed.length);
console.log("typed pop", shadowed.pop(), shadowed.length);

// A plain array keeps the builtin for the same names.
const plain = [1, 2];
console.log("plain push", plain.push(3), plain.length, plain.join(","));
console.log("plain pop", plain.pop(), plain.join(","));
const plainSeen: number[] = [];
plain.forEach((value) => plainSeen.push(value));
console.log("plain forEach", plainSeen.join(","));

// The fields are own properties, listed after the elements.
console.log("keys", Object.keys(shadowed).join(","), shadowed instanceof Shadowed);
