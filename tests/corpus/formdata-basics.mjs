// The global FormData: the constructor with no arguments, append/set over
// repeated names, get/getAll/has/delete, the string conversions Node does
// for values, the File a Blob or File entry becomes (its filename from the
// third argument or the File's name, "blob" for a Blob, and the Blob's
// type), the class identity and tag, and Node's argument errors.

const form = new FormData();
form.append("a", "1");
form.append("a", 2);
form.set("b", "x");
console.log(form.get("a"), form.getAll("a").length, form.has("b"), form.has("c"));
form.delete("a");
console.log(form.get("a"), form.getAll("a").length);
console.log(form instanceof FormData, Object.prototype.toString.call(form), typeof FormData);
const file = new File(["abc"], "f.txt", { type: "text/plain" });
form.append("file", file);
const entry = form.get("file");
console.log(entry instanceof File, entry.name, entry.type, entry.size);
form.append("blob", new Blob(["xy"]));
const blobEntry = form.get("blob");
console.log(blobEntry instanceof File, blobEntry.name, blobEntry.size);
try {
  form.append("k", "v", "n.txt");
} catch (error) {
  console.log("filename", error.name, error.message);
}
try {
  form.append("k");
} catch (error) {
  console.log("arity", error.name, error.message);
}
try {
  form.append(Symbol("s"), "v");
} catch (error) {
  console.log("symbol", error.name, error.message);
}
console.log(Object.keys(form).length, form.constructor === FormData);
