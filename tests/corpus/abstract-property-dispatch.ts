class Payload {
  value = 1;
}
abstract class Store {
  abstract name: string;
  abstract readonly payload: Payload;
  describe(): string { return this.name; }
  rename(value: string): void { this.name = value; }
}
class Fields extends Store {
  prefix = 7;
  name = "field";
  payload = new Payload();
}
class Accessors extends Store {
  current = "getter";
  data = new Payload();
  get name(): string {
    return this.current;
  }
  set name(value: string) {
    this.current = value;
  }
  get payload(): Payload {
    return this.data;
  }
}
class Inherited extends Fields {
  extra = true;
}
let calls = 0;
function receiver(value: Store): Store {
  calls++;
  return value;
}
function update(value: Store): string {
  receiver(value).name += "!";
  value.payload.value++;
  return value.name;
}
const field = new Fields();
const accessor = new Accessors();
const inherited = new Inherited();
console.log(update(field), update(accessor), update(inherited), calls);
console.log(field.payload.value, accessor.data.value, inherited.payload.value);
function read(value: Store): Payload {
  return value.payload;
}
console.log(read(field) === field.payload, read(accessor) === accessor.data);
console.log(Object.keys(field).join(","), Object.keys(accessor).join(","));
console.log(Object.getOwnPropertyDescriptor(field, "name")?.enumerable);
field.rename("updated field");
accessor.rename("updated accessor");
console.log(field.describe(), accessor.describe(), inherited.describe());
