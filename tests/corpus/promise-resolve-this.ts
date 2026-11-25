// Promise.resolve of a value typed as the enclosing class lowers like any
// other promise of that class: `this` inside a method, a parameter of the
// class type, and a subclass instance through the base type.
class Sheet {
  rules: number[] = [];
  replace(): Promise<Sheet> {
    return Promise.resolve(this);
  }
}
new Sheet().replace().then((s) => console.log("method " + s.rules.length));

function resolved(sheet: Sheet): Promise<Sheet> {
  return Promise.resolve(sheet);
}
resolved(new Sheet()).then((s) => console.log("free " + s.rules.length));

class RuleSheet extends Sheet {
  extra(): Promise<Sheet> {
    return Promise.resolve(this);
  }
}
new RuleSheet().extra().then((s) => console.log("subclass " + s.rules.length));

// A direct instance keeps the same lowering.
Promise.resolve(new Sheet()).then((s) => console.log("direct " + s.rules.length));
