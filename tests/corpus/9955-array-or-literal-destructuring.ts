// A destructuring pattern over a conditional whose arms are an array and an
// array literal: both are arrays, and the pattern reads positions, with a
// missing position undefined.
function split(arg: string): string {
  const [name, value] = arg[1] === "-" ? arg.split(/=(.*)/, 2) : [arg, undefined];
  return `${name}|${value}`;
}
console.log(split("--tag=a=b"), split("--help"), split("-h"), split("--empty="));

function parts(arg: string, limit: number): string {
  const [head, next, last] = arg.includes(",") ? arg.split(",", limit) : [arg, "none", undefined];
  return [head, next, last].map((part) => String(part)).join("/");
}
console.log(parts("a,b,c", 3), parts("a,b,c", 2), parts("a", 3), parts("x,", 3));

function flags(text: string): string {
  const [first, second] = text.length > 2 ? text.split("").map((ch) => ch === "y") : [false, true];
  return `${first} ${second}`;
}
console.log(flags("yny"), flags("n"));
