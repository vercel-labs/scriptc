// A constant symbol getter read through a typed class-value parameter. No
// subclass below `Gate` redeclares the getter, so the runtime class cannot
// change the answer and the read compiles: the class and its subclass answer
// the getter's value, exactly as the direct reads do.
const gate = Symbol();

class Gate {
  static get [gate](): boolean {
    return true;
  }
}

class Sub extends Gate {}

function readGate(ctor: typeof Gate): boolean {
  return ctor[gate];
}

console.log(readGate(Gate), readGate(Sub), Gate[gate], Sub[gate]);
