// WHATWG FormData as undici implements it: append/set/get/getAll/has/delete
// over an ordered entry list, the three iterators and Symbol.iterator,
// forEach, the inspector view, Blob→File entry conversion with an optional
// filename, and the methods' arity/conversion TypeErrors.
const form = new FormData();
console.log(form);
console.log(form instanceof FormData, Object.prototype.toString.call(form));
console.log(form.has("a"), form.get("a"), form.getAll("a").length);

form.append("a", "1");
form.append("a", "2");
form.append("b", "3");
console.log(form);
console.log(form.get("a"), form.getAll("a"), form.has("a"), form.has("c"));
console.log([...form.keys()]);
console.log([...form.values()]);
console.log([...form.entries()]);
for (const [key, value] of form) console.log("for-of", key, value);
const seen: string[] = [];
form.forEach((value, key) => seen.push(`${key}=${value}`));
console.log(seen.join(" "));

form.delete("a");
console.log(form, form.has("a"), form.getAll("a").length);
form.set("b", "9");
form.set("b", "10");
form.append("b", "x");
console.log([...form.keys()], form.get("b"), form.getAll("b").length);
form.set("b", "11");
console.log([...form.keys()], form.get("b"), form.getAll("b").length);
console.log(form);

// Every value converts to a USVString unless it is a Blob (Node's types
// take string | Blob, so the conversions below are cast).
const untypedForm = form as any;
untypedForm.append("number", 5);
untypedForm.append("boolean", false);
untypedForm.append("null", null);
untypedForm.append("object", { toString: () => "obj-string" });
console.log(form.get("number"), form.get("boolean"), form.get("null"), form.get("object"));

// A Blob value becomes a File named "blob"; the optional third argument
// names it, and a File keeps its own name, type and lastModified.
const blob = new Blob(["xyz"], { type: "application/x-thing" });
form.append("blob", blob);
form.append("named", new Blob(["q"]), "custom.bin");
const file = new File(["hello"], "hello.txt", { type: "text/plain" });
form.append("file", file);
form.append("renamed", file, "renamed.txt");
for (const name of ["blob", "named", "file", "renamed"]) {
  const value = form.get(name);
  if (!(value instanceof File)) throw new Error(`not a File: ${name}`);
  console.log(name, value.name, JSON.stringify(value.type), value.size, value instanceof Blob);
}
const kept = form.get("renamed");
if (kept instanceof File) console.log(kept.lastModified === file.lastModified);

// The argument checks, in undici's wording. The casts reach the same
// handle methods the typed calls do; only the checked arguments differ.
const failure = (run: () => void): string => {
  try {
    run();
    return "no throw";
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
};
const untyped = form as any;
// @ts-ignore -- Node's types take no constructor argument (undici's is a DOM
// form element); the runtime reports Node's conversion TypeError for one.
console.log(failure(() => new FormData(1)));
// @ts-ignore -- undefined is the one argument Node's constructor accepts.
console.log(new FormData(undefined) instanceof FormData);
console.log(failure(() => untyped.append("only-name")));
console.log(failure(() => untyped.append("str", "value", "file.txt")));
console.log(failure(() => untyped.set("num", "value", "f")));
console.log(failure(() => untyped.has()));
console.log(failure(() => untyped.get()));
console.log(failure(() => untyped.getAll()));
console.log(failure(() => untyped.delete()));
console.log(failure(() => untyped.set("num")));
