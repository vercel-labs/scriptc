// Object literals with get/set accessors keep their closures in reserved
// slots, so their typed values have no JSON form: Node's JSON.stringify
// invokes the getter, which the typed serializer cannot do.

const counter = {
  count: 1,
  get doubled(): number {
    return 2;
  },
};

// JSON.stringify of the typed value would omit the getter's property.
console.log(JSON.stringify(counter));

// A literal written into an `any` slot directly keeps its accessor.
const direct: any = {
  get value(): number {
    return 3;
  },
};
console.log(direct.value);
