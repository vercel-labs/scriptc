// A tagged template through a dynamic member runs with its receiver as
// `this`, exactly as the equivalent member call does.
const holder = {
  prefix: "p",
  tag(strings: readonly string[], ...values: unknown[]): string {
    const self = this as { prefix: string };
    return self.prefix + "|" + strings.join("~") + "|" + values.join(",");
  },
};
const dynamic: any = holder;
console.log(dynamic.tag`a${1}b${2}c`);
console.log(dynamic.tag`plain`);
const key = "tag";
console.log(dynamic[key]`x${3}y`);

class Greeter {
  prefix = "c";
  tag(strings: readonly string[], ...values: unknown[]): string {
    return this.prefix + "|" + strings.join("~") + "|" + values.join(",");
  }
}
const instance: any = new Greeter();
console.log(instance.tag`m${4}n`);
console.log(instance[key]`z${5}`);
