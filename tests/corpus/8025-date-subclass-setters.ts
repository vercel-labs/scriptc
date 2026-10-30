// Setters on instances of a class declared `extends Date`: each changes
// the instance's time value, which the inherited getters, the subclass's
// own methods and toISOString then read; invalid instances follow the same
// rules as Dates.
export {};
process.env.TZ = "Asia/Kolkata";

class Deadline extends Date {
  label: string;
  constructor(label: string, ms: number) {
    super(ms);
    this.label = label;
  }
  extend(days: number): this {
    this.setDate(this.getDate() + days);
    return this;
  }
  describe(): string {
    return `${this.label} ${this.toISOString()}`;
  }
}

const due = new Deadline("report", Date.UTC(2026, 9, 23, 18, 30));
console.log(due.describe());
console.log(due.setHours(9, 15), due.getHours(), due.getMinutes());
console.log(due.extend(10).describe());
console.log(due.setUTCMonth(0, 31), due.setMonth(1), due.getDate(), due.getMonth());
console.log(due.setFullYear(2024, 1, 29), due.describe());
console.log(due.setTime(Number.NaN), Number.isNaN(due.getTime()), due.setUTCFullYear(2030));
console.log(due.describe(), due instanceof Date, due instanceof Deadline);
