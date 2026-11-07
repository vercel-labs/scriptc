// for await over process.stdin after setEncoding, with no input: the
// iteration hands out no chunk, so it just ends, as in Node. Only a chunk
// handed to the loop is refused.
async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let chunks = 0;
  for await (const chunk of process.stdin) chunks += chunk.length > 0 ? 1 : 0;
  console.log("iterated", chunks);
}
void main();
