// typeof on names the program declares (`declare const`, `declare function`)
// but nothing defines at run time answers "undefined"; reading them throws
// ReferenceError.
declare const Bun: { randomUUIDv7: () => string } | undefined;
declare const Deno: { version: { deno: string } };
declare function webkitRequestAnimationFrame(callback: () => void): number;
console.log("start");
console.log(typeof Bun, typeof Deno, typeof webkitRequestAnimationFrame);
console.log(typeof Bun !== "undefined" ? Bun?.randomUUIDv7() : "no Bun");
const runtime = typeof Deno === "object" ? "deno" : typeof Bun === "object" ? "bun" : "node";
console.log(runtime);
try {
  console.log(Bun);
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
try {
  console.log(typeof Deno.version);
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
