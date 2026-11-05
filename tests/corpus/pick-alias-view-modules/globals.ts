import type { Ctx } from "./ctx.ts";
import type { ModelKind, RegistryView } from "./registry.ts";
function toKind(value: unknown): ModelKind {
  return value === "image" ? "image" : "chat";
}
function globals(models: RegistryView): (args: unknown[]) => string {
  return (args) => {
    const [kind] = args;
    return models.modelsOfKind(toKind(kind)).map((m) => m.id).join(",");
  };
}
export function run(ctx: Ctx | undefined): string {
  const list = ctx ? globals(ctx.registry) : undefined;
  return list ? `${ctx?.label} ${list(["chat"])} ${list(["image"])}` : "none";
}
