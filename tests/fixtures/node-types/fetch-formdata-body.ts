/* A FormData body typechecks under @types/node's BodyInit, and the native
 * fetch sends undici's multipart/form-data encoding for it, so a build
 * compiles it and the program runs instead of refusing the type by name. */
const form = new FormData();
form.append("field", "value");
form.append("file", new Blob(["bytes"], { type: "text/plain" }), "notes.txt");
const request = new Request("https://example.invalid/", { method: "POST", body: form });
console.log(form.get("field"), form.getAll("file").length, request.method);
