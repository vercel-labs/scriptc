// A record passed to a `{}` parameter and converted to a dictionary inside
// the function is the same object: the write through the dictionary
// reaches the caller's record. A dot write through a dictionary view of a
// class instance replaces its method.
const key = process.argv.length > 99 ? "never" : "added";
function stamp(value: {}): void {
  const table: Record<string, string> = value;
  table[key] = "y";
}
const record: { a: string } = { a: "x" };
stamp(record);
console.log(JSON.stringify(record), key in record);

// A dot write through the dictionary view replaces a method too.
class Lamp {
  on = false;
  toggle(): boolean {
    this.on = !this.on;
    return this.on;
  }
}
const lamp = new Lamp();
const lampView: {} = lamp;
const lampSlots: Record<string, string> = lampView;
lampSlots.toggle = "replaced";
try {
  console.log(lamp.toggle());
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
