// process.stdin.setEncoding("utf8"), then a 'data' listener whose parameter
// has no annotation. The declarations type the chunk as bytes, and Node
// delivers a string: Node prints the text, and the compiled program refuses
// the delivery by name instead of handing the listener bytes.
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  text += chunk;
});
process.stdin.on("end", () => {
  console.log(JSON.stringify(text.trim()));
});
