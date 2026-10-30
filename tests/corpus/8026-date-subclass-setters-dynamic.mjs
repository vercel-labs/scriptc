// Setters on instances of a JavaScript class declared `extends Date`, held
// as untyped values: the inherited setters change the instance's time value.
process.env.TZ = "America/Sao_Paulo";

class Shift extends Date {
  start() {
    this.setHours(8, 0, 0, 0);
    return this;
  }
}

const shift = new Shift(Date.UTC(2026, 4, 5, 15));
console.log(shift.start().toISOString(), shift.getHours());
console.log(shift.setDate(31), shift.getMonth(), shift.setUTCHours(0), shift.toISOString());
const values = [shift, new Shift(0)];
for (const value of values) value.setUTCMinutes(45);
console.log(values.map((value) => value.toISOString()).join(" "), values[0] === shift);
