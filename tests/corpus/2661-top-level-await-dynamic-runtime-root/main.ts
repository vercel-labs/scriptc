// @dynamic
async function discoveredFirstButNeverRun() {
  return import("./a.ts");
}

void discoveredFirstButNeverRun;

console.log("main");
const b = import("./b.ts");
const a = import("./a.ts");
void b.then(() => console.log("b done"));
void a.then(() => console.log("a done"));
