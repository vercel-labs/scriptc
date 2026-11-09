// process.stdin.setEncoding("utf8"), then a 'data' listener whose parameter
// is declared string: the chunks are the decoded text, as in Node.
let text = "";
let chunks = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  chunks++;
  text += chunk;
});
process.stdin.on("end", () => {
  console.log(typeof text, JSON.stringify(text.trim()), chunks > 0);
});
