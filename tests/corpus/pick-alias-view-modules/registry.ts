export interface ChatModel { kind: "chat"; id: string }
export interface ImageModel { kind: "image"; id: string; size: number }
export interface ModelMap { chat: ChatModel; image: ImageModel }
export type ModelKind = keyof ModelMap;
export class Registry {
  private readonly all: (ChatModel | ImageModel)[] = [
    { kind: "chat", id: "c1" },
    { kind: "image", id: "i1", size: 512 },
  ];
  modelsOfKind<K extends ModelKind>(kind: K, provider?: string): readonly ModelMap[K][] {
    return this.all.filter((m) => m.kind === kind && provider !== "none") as ModelMap[K][];
  }
  modelOfKind<K extends ModelKind>(kind: K, id: string): ModelMap[K] | undefined {
    for (const m of this.modelsOfKind(kind)) if (m.id === id) return m;
    return undefined;
  }
  label(): string {
    return "registry";
  }
}
export type RegistryView = Pick<Registry, "modelsOfKind" | "modelOfKind" | "label">;
