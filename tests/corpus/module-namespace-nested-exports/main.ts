// A module namespace handed on as a value whose members are themselves
// module namespaces: `export * as Shapes from "./shapes.ts"` and `export
// default <namespace import>`. Each member answers that module's own
// namespace object, the same one every time.
import * as kit from "./kit.ts";

const modules: Record<string, unknown> = { kit };
function member(holder: unknown, name: string): unknown {
  return (holder as Record<string, unknown>)[name];
}

const held = modules.kit;
console.log(Object.keys(held as object).join());
const shapes = member(held, "Shapes");
console.log(typeof shapes, Object.keys(shapes as object).join());
console.log(member(shapes, "unit"), typeof member(shapes, "circle"));
const circle = member(shapes, "circle") as (radius: number) => number;
console.log(circle(2));
const dflt = member(held, "default");
console.log(typeof dflt, Object.keys(dflt as object).join(), member(dflt, "unit"));
console.log(dflt === shapes, member(held, "Shapes") === shapes, member(held, "version"));
console.log(member(shapes, "missing"), "Shapes" in (held as object), "circle" in (shapes as object));
