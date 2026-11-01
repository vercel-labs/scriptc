// A `declare` field is erased, so the only property under its name is one
// an assignment creates. The constructor write below is an ordinary
// assignment and makes the field present; the field nobody assigns stays
// absent.
class Assigned {
  declare value: number;
  declare label: string;
  constructor() {
    this.value = 1;
  }
  bump(): number {
    this.value = this.value + 1;
    return this.value;
  }
  labelInThis(): boolean {
    return "label" in this;
  }
}
const assigned = new Assigned();
console.log("assigned:", "value" in assigned, assigned.value, assigned.bump(), assigned.value);
console.log("label:", assigned.labelInThis(), "label" in assigned, assigned.label);
