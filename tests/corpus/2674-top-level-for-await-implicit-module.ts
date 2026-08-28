let chunks = 0;
for await (const chunk of process.stdin) chunks += chunk.length;

console.log(chunks);
