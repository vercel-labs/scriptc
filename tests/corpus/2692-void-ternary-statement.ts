// A conditional expression over two `void` calls carries no value — it only
// compiles where JS discards it: statement position and void-returning
// concise arrow bodies. Those lower as if/else over the taken arm; a
// CONSUMED void ternary stays fenced.
let log = "";
function a(): void {
  log += "a";
}
function b(): void {
  log += "b";
}
function loud(tag: string): void {
  log += tag;
}

// statement position: only the taken arm's effects run
const flag = process.argv.length > 99;
flag ? a() : b();
false ? loud("skipped") : b();
true ? a() : loud("skipped");

// nested arms: the inner ternary rides the outer's if/else reshape
const deep = process.argv.length > 99;
deep ? (flag ? a() : loud("x")) : b();
flag ? a() : deep ? loud("y") : b();

// concise arrow bodies returning void (SC1090's documented surface)
const pick = (n: number) => (n > 0 ? a() : b());
pick(1);
pick(-1);

// generic arrow with an inferred void return
const ident = <T,>(v: T) => (typeof v === "string" ? loud("s") : b());
ident("x");
ident(1);

// narrowing reaches both arms
const use = (n: string | number) => (typeof n === "string" ? loud(`str:${n}`) : loud("num"));
use("hi");
use(7);

// comma spelling hands its left operand to the same statement lowering
void (flag ? a() : b(), 0);

console.log(log);
