// Generic class methods called through a Pick<>/Omit<> view of the class
// that is NAMED by a type alias (`type View = Pick<Registry, ...>`), also
// through an alias of that alias. Inline Pick<> views already compile; the
// alias hides the Pick from the view's type, which then mapped to a
// record of erased method fields that a Registry instance cannot convert to.
interface ChatModel {
  kind: "chat";
  id: string;
}
interface ImageModel {
  kind: "image";
  id: string;
  size: number;
}
interface ModelMap {
  chat: ChatModel;
  image: ImageModel;
}
type ModelKind = keyof ModelMap;

class Registry {
  private readonly all: (ChatModel | ImageModel)[] = [
    { kind: "chat", id: "c1" },
    { kind: "image", id: "i1", size: 512 },
    { kind: "chat", id: "c2" },
  ];
  modelsOfKind<K extends ModelKind>(kind: K, provider?: string): readonly ModelMap[K][] {
    return this.all.filter((m) => m.kind === kind && provider !== "none") as ModelMap[K][];
  }
  modelOfKind<K extends ModelKind>(kind: K, id: string): ModelMap[K] | undefined {
    for (const m of this.modelsOfKind(kind)) if (m.id === id) return m;
    return undefined;
  }
  async availableOfKind<K extends ModelKind>(kind: K, options?: { tag?: string }): Promise<readonly ModelMap[K][]> {
    return this.modelsOfKind(kind).filter(() => options?.tag !== "none");
  }
  label(): string {
    return "registry";
  }
}

type RegistryView = Pick<Registry, "modelsOfKind" | "modelOfKind" | "availableOfKind" | "label">;
type ReadOnlyView = RegistryView;
type NoAsyncView = Omit<Registry, "availableOfKind">;

function toKind(value: unknown): ModelKind {
  return value === "image" ? "image" : "chat";
}

function describe(models: RegistryView, args: unknown[]): string {
  const [kind, id] = args;
  const list = models.modelsOfKind(toKind(kind)).map((m) => m.id);
  const one = models.modelOfKind(toKind(kind), String(id));
  return `${models.label()} ${list.join(",")} ${one === undefined ? "none" : one.id}`;
}

function globals(models: ReadOnlyView): Record<string, (args: unknown[]) => unknown> {
  return {
    list: (args) => models.modelsOfKind(toKind(args[0]), args[1] === undefined ? undefined : String(args[1])).length,
    size: (args) => models.modelOfKind("image", String(args[0]))?.size ?? -1,
  };
}

function sizes(models: NoAsyncView): string {
  return models.modelsOfKind("image").map((m) => `${m.id}:${m.size}`).join(",");
}

async function main(): Promise<void> {
  const registry = new Registry();
  console.log(describe(registry, ["chat", "c2"]));
  console.log(describe(registry, ["image", "zz"]));
  const g = globals(registry);
  console.log(g.list!(["chat"]), g.list!(["chat", "none"]), g.size!(["i1"]), g.size!(["c1"]));
  console.log(sizes(registry));
  const view: RegistryView = registry;
  const available = await view.availableOfKind("image", { tag: "x" });
  console.log(available.map((m) => `${m.id}:${m.size}`).join(","), (await view.availableOfKind("chat", { tag: "none" })).length);
}
main();
