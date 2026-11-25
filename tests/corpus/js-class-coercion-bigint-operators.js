// A class instance whose coercion hook answers a BigInt takes part in the
// numeric operators the way Node applies them: ToNumeric of each operand,
// then the BigInt operation. Unary minus negates the BigInt and complement
// complements it.
class Two {
  [Symbol.toPrimitive]() {
    return 2n;
  }
}
class Three {
  [Symbol.toPrimitive]() {
    return 3n;
  }
}
const two = new Two();
const three = new Three();
console.log(two - three, two * three, two / three, two % three, two ** three);
console.log(two & three, two | three, two ^ three, two << three, two >> three);
console.log(-two, -three, ~two, ~three);
console.log(typeof (two - three), typeof (two & three), typeof -two, typeof ~two);

// A hook that answers a number keeps the number answer, and negation keeps
// the sign of zero.
class Five {
  [Symbol.toPrimitive]() {
    return 5;
  }
}
class Zero {
  [Symbol.toPrimitive]() {
    return 0;
  }
}
const five = new Five();
console.log(-five, ~five, 1 / -five);
console.log(Object.is(-new Zero(), -0), 1 / -new Zero(), -new Zero() === 0);

// Mixed number and BigInt operands throw Node's TypeError.
try {
  console.log(two - five);
} catch (error) {
  console.log(error.constructor.name, error.message);
}

// `valueOf` takes part through the ordinary conversion, and the result of a
// negation is a BigInt that the BigInt operators accept.
class Value {
  valueOf() {
    return 7n;
  }
}
console.log(-new Value(), typeof -new Value(), -new Value() * new Value());
