// @dynamic
// Missing substitutions remain undefined across both a typed direct tag and
// the dynamic rest-argument tag ABI.
const values = ["ok"];

function typed(parts: TemplateStringsArray, value: string | undefined): string {
  return `${parts.join("|")}:${String(value)}`;
}
console.log(typed`a${values[0]}b`);
console.log(typed`a${values[9]}b`);

function dynamicRest(...args: any[]): string {
  return `${args.length}:${String(args[1])}`;
}
console.log(dynamicRest`a${values[9]}b`);
