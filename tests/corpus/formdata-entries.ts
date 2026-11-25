// A typed FormData: the methods lower through the class's checked-dynamic
// handle, an appended File comes back as a File with its name and contents,
// and set() replaces the first value and drops the rest.

const form = new FormData();
form.append("name", "value");
form.append("name", "second");
form.set("name", "replaced");
console.log(form.getAll("name").length, form.get("name"));
form.append("file", new File(["abc"], "a.txt", { type: "text/plain" }));
const entry = form.get("file");
console.log(entry instanceof File, (entry as File).name, (entry as File).size);
console.log(form instanceof FormData, typeof FormData);
form.delete("name");
console.log(form.has("name"), form.getAll("name").length);
