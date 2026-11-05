// `.filter` with a written type predicate whose target is no arm of the
// element union but the same fields as one, with a nested union field the
// predicate narrows (`Model<"a">` from the `Model<Api>` arm). Kept elements
// convert field by field; a kept element of another shape would throw.

interface CompatA {
  strict?: boolean;
}
interface CompatB {
  effort?: string;
}
interface CompatMap {
  a: CompatA;
  b: CompatB;
}
type Api = keyof CompatMap;
interface Model<A extends Api> {
  kind: "chat";
  api: A;
  id: string;
  window: number;
  compat?: CompatMap[A];
}
interface Image {
  kind: "image";
  id: string;
}
type AnyModel = Model<Api> | Image;

function restore(stored: AnyModel[]): Model<"a">[] {
  return stored.filter((model): model is Model<"a"> => model.kind === "chat" && model.api === "a");
}

const stored: AnyModel[] = [
  { kind: "chat", api: "a", id: "1", window: 8, compat: { strict: true } },
  { kind: "image", id: "2" },
  { kind: "chat", api: "b", id: "3", window: 4, compat: { effort: "hi" } },
  { kind: "chat", api: "a", id: "4", window: 2 },
];
const restored = restore(stored);
for (const model of restored) console.log(model.id, model.api, model.window, model.compat?.strict, "compat" in model);
console.log(restored.length, restored.map((model) => model.window).reduce((a, b) => a + b, 0));

// A target that is itself an arm of the union keeps that arm's elements as
// they are, while another arm with its fields converts.
type Mixed = Model<"a"> | Model<Api> | Image;
function pick(stored: Mixed[]): Model<"a">[] {
  return stored.filter((model): model is Model<"a"> => model.kind === "chat" && model.api === "a");
}
const exact: Model<"a"> = { kind: "chat", api: "a", id: "5", window: 3, compat: { strict: false } };
const picked = pick([exact, ...stored]);
console.log(picked.map((model) => `${model.id}:${model.window}:${model.compat?.strict}`).join(" "), picked[0] === exact);

export {};
