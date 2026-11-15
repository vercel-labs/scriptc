// A JavaScript class that extends Array: `this.length = n` in a method
// writes the array's own length, which every read then answers.
export class Listy extends Array {
  refresh() {
    this.length = 0;
  }
  truncate(n) {
    this.length = n;
    return this.length;
  }
}
