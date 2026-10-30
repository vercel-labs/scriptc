// ReadableStream tee() reached through an element access with a string key
// is the program's only web stream operation: the program still links the
// web stream classes, so a Response body splits into two branches.

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    out += decoder.decode(result.value, { stream: true });
  }
  return out + decoder.decode();
}

async function main(): Promise<void> {
  const body = new Response("split me").body!;
  const [left, right] = body["tee"]();
  console.log("element tee", await text(left), "|", await text(right), body.locked);
}

void main();
