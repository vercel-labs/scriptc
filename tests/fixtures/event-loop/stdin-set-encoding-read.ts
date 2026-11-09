// process.stdin.read() after setEncoding: Node answers a string. The
// compiled read answers a Buffer, so it is refused by name.
process.stdin.setEncoding("utf8");
process.stdin.on("readable", () => {
  const chunk = process.stdin.read();
  if (chunk !== null) console.log("chunk", typeof chunk);
});
