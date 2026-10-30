// Mapped types instantiated over concrete arguments whose key filter keeps
// no key (a per-kind model catalog with no models of that kind,
// `Record<never, T>`, `Partial<{}>`) are the empty object type: values flow
// through them like any `{}`-typed value.
type Groups = Record<string, Record<string, object>>;
type Key<G extends Groups> = { [A in keyof G]: keyof G[A] }[keyof G] & string;
type KeyOf<G extends Groups, T extends string> = Extract<Key<G>, `${T}:${string}`>;
type Id<K extends string> = K extends `${string}:${infer M}` ? M : never;
type Catalog<G extends Groups, T extends string> = {
  [K in KeyOf<G, T> as Id<K>]: { id: Id<K>; name: string };
};

const data = { api: { "chat:a": { id: "a", name: "A" }, "chat:b": { id: "b", name: "B" } } };

const chat: Catalog<typeof data, "chat"> = { a: { id: "a", name: "A" }, b: { id: "b", name: data.api["chat:b"].name } };
const image: Catalog<typeof data, "image"> = {};
const video: Catalog<typeof data, "video"> = image;
console.log(chat.a.name, chat.b.id, JSON.stringify(image), video === image);

const none: Record<never, number> = {};
const partial: Partial<{}> = { extra: 1 } as {};
console.log(JSON.stringify(none), JSON.stringify(partial));

function describe(value: Catalog<typeof data, "image">): string {
  return JSON.stringify(value);
}
const catalogs: Catalog<typeof data, "image">[] = [image, {}, none];
console.log(describe(image), describe({}), catalogs.map(describe).join(" "));

// A module-level alias without type arguments whose filter keeps no key.
type Flags = { [K in "a" | "b" as K extends "c" ? K : never]: boolean };
const flags: Flags = {};
console.log(JSON.stringify(flags), JSON.stringify([flags, none]));
