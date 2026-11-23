// Dynamic values crossing into declared types: each export names a runtime
// unit the library archive links only when the program reaches it.
interface Note {
  title: string;
  tags: string[];
}

class Problem extends Error {}

// A data literal in an untyped context is built dynamic; its cast to Note
// adopts it (scr_decl_adopt.c), so both names hold one object.
export function castShares(): boolean {
  const data: unknown = { title: "milk", tags: ["a"] };
  const note = data as Note;
  note.tags.push("b");
  return (data as Note).tags.length === 2;
}

// A typed slot taking a dynamic value keeps one identity with it, as in Node.
export function slotShares(): boolean {
  const raw: any = JSON.parse('{"title":"milk","tags":["a"]}');
  const note: Note = raw;
  raw.tags.push("b");
  note.title = "eggs";
  return raw.title === "eggs" && note.tags.length === 2;
}

// instanceof on a dynamic value walks its prototype (scr_dyn_class_test.c).
export function classTest(): boolean {
  const value: unknown = JSON.parse('{"message":"x"}');
  return !(value instanceof Problem) && new Problem("x") instanceof Error;
}
