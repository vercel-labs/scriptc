// for await over process.stdin after setEncoding: Node yields strings. The
// compiled loop takes Buffers, so the first step is refused by name.
async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) console.log("chunk", typeof chunk);
}
void main();
