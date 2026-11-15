// Legacy decorators: the tsconfig sets experimentalDecorators, under which a
// property decorator is called with the prototype and the member name. One
// diagnostic names the setting; the checker's errors about each decorator's
// signature under the standard semantics do not follow it.
function column(target: object, key: string): void {
  console.log(typeof target, key);
}

function logged(target: object, key: string, descriptor: PropertyDescriptor): void {
  console.log(typeof target, key, typeof descriptor.value);
}

class Row {
  @column id = 1;
  @column name = "n";
  @logged
  save(): void {}
}

console.log(new Row().id);
