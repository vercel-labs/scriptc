// @requires-libnode
// pi packages/ai/src/utils/validation.ts:344-349 in miniature: a failed
// `Check(value): value is Encode` narrows `args` to never, and the error
// list it then maps over comes from an island handle. The value still
// exists at run time, so it must reach the island and the array
// lowering must see a real error array rather than a generic-method
// refusal.
import { Compile, Type } from "fakebox";
import type { TLocalizedValidationError, TSchema } from "fakebox";

interface Tool {
  name: string;
  parameters: TSchema;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
  return Compile(schema);
}

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

function validate(tool: Tool, args: JsonObject): string {
  const validator = getValidator(tool.parameters);
  if (validator.Check(args)) {
    return "ok";
  }
  const errors =
    validator
      .Errors(args)
      .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
      .join("\n") || "Unknown validation error";
  return `validation failed:\n${errors}`;
}

const tool: Tool = { name: "read", parameters: Type.Object({ path: Type.String() }) };
console.log(validate(tool, { good: true }));
console.log(validate(tool, { path: 3 }));
