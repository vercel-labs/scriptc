/**
 * A name the union's classes do not declare can still be on the value at
 * runtime, because an untyped view adds it. The arm that does not declare
 * the key answers from the instance's own property state, the way a
 * single-class receiver already does, instead of reporting it absent.
 */
class Shape {
  sides = 3;
}
class Label {
  text = "label";
}

function attach(target: any, name: string, value: number): void {
  target[name] = value;
}

function report(value: Shape | Label): void {
  console.log("extra" in value, "sides" in value, "text" in value, "toString" in value);
}

const shape = new Shape();
const label = new Label();
report(shape);
report(label);
attach(shape, "extra", 1);
attach(label, "extra", 2);
report(shape);
report(label);
console.log("extra" in shape, "extra" in label);
