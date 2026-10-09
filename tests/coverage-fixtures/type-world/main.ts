// Valid under this project's own tsc (its "lib" is esnext): the errors
// come from scriptc's fixed type world and say so.
const bytes = Uint8Array.fromBase64("aGk=");
console.log(bytes.length);
const runtime = typeof Deno === "undefined" ? "node" : "other";
console.log(runtime);
