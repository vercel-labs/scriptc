function run(fn: Function): void {
  fn();
}

function runWithArg(fn: Function, msg: string): void {
  fn(msg);
}

run(() => {
  console.log("hello from Function");
});

runWithArg((m: string) => {
  console.log("arg:", m);
}, "world");

const f: Function = (a: number, b: number) => a + b;
console.log("result:", f(2, 3));
