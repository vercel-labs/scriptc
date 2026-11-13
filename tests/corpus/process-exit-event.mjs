// @exit: 9
// The 'exit' event: listeners run once, in registration order, when the
// process is about to leave, and the argument is the exit code the process
// answers with. exitCode assigned before exit is the code listeners see,
// and a listener that assigns exitCode selects the status the process
// leaves with — the "decide the final status in an exit hook" shape.
const order = [];

process.on("exit", (code) => {
  order.push(`first:${code}:${typeof code}:${code === 42}`);
});
process.once("exit", (code) => {
  order.push(`once:${code}`);
  process.exitCode = 9;
});
process.on("exit", (code) => {
  order.push(`last:${code}:${process.exitCode}`);
  console.log(order.join("|"));
});
process.exitCode = 42;
console.log("main", process.exitCode);
