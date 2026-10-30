// @requires-libnode
// Typed code names an island package's declared interfaces and generic
// aliases: the package's declarations type it, while its values cross the
// boundary as handles.
import { Arr, Num, Str, check, type Static, type TArray, type TNumber, type TSchema, type TString } from "schemakit";

interface Tool<T extends TSchema = TSchema> {
  name: string;
  parameters: T;
  execute(id: string, params: Static<T>): string;
}

const sum: Tool<TArray<TNumber>> = {
  name: "sum",
  parameters: Arr(Num()),
  execute: (id, params) => `${id}: ${params.reduce((a, b) => a + b, 0)}`,
};
const shout: Tool<TString> = {
  name: "shout",
  parameters: Str(),
  execute: (id, params) => `${id}: ${params.toUpperCase()}`,
};

function run<T extends TSchema>(tool: Tool<T>, input: unknown): string {
  if (!check(tool.parameters, input)) return `${tool.name}: rejected ${JSON.stringify(input)}`;
  return tool.execute(tool.name, input);
}

function describeAll(schemas: TSchema[]): string[] {
  return schemas.map((s) => `${s.kind} ${s.describe()}`);
}

console.log(run(sum, [1, 2, 3]));
console.log(run(sum, [1, "2"]));
console.log(run(shout, "quiet"));
console.log(run(shout, 7));
console.log(describeAll([sum.parameters, shout.parameters, Arr(Arr(Str()))]).join(" | "));
const tools: Tool[] = [sum, shout];
console.log(tools.map((t) => t.name).join(","));
