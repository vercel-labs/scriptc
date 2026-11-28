// A computed-name STATIC accessor keyed by a module-level symbol: TS's
// unique-symbol members. The getter is lowered like a named static getter
// (the accessor-colon slot), reads through the class value and through a
// subclass answer the getter's value, and a subclass's own getter overrides
// the inherited one. Two description-less symbols stay two keys.
const gate = Symbol();
const sized = Symbol();

class Gate {
  static get [gate](): boolean {
    return true;
  }
  static get [sized](): number {
    return 3;
  }
  static set [sized](value: number) {
    void value;
  }
}

class Sub extends Gate {}
class Override extends Gate {
  static get [gate](): boolean {
    return false;
  }
}

console.log('gate:', Gate[gate], Sub[gate], Override[gate]);
console.log('sized:', Gate[sized], Sub[sized], Override[sized]);
console.log('types:', typeof Gate[gate], typeof Gate[sized]);
