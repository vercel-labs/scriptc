// After setEncoding, a read that hands out no chunk answers null as in Node:
// read(0), which Node uses to trigger a refill, and a read() before any
// input. Neither is refused, so the string 'data' listener behind them
// receives the decoded text.
let text = "";
process.stdin.setEncoding("utf8");
console.log("read(0)", process.stdin.read(0));
console.log("read()", process.stdin.read());
process.stdin.on("data", (chunk: string) => {
  text += chunk;
});
process.stdin.on("end", () => {
  console.log(typeof text, JSON.stringify(text.trim()));
});
