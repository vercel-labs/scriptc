// A Response or Request body from a ReadableStream whose queue filled
// before the body is read: text(), bytes() and json() read the rest of the
// stream to its close after a timer has run.
const encoder = new TextEncoder();
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function main(): Promise<void> {
  const fromArray = new Response(ReadableStream.from([encoder.encode("from "), encoder.encode("array")]));
  await tick();
  console.log("from", await fromArray.text(), fromArray.bodyUsed);

  let pulls = 0;
  const pulled = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(encoder.encode(`p${pulls}`));
        if (pulls === 3) controller.close();
      },
    }),
  );
  await tick();
  console.log("pull", await pulled.text(), pulls);

  const started = new Request("http://example.com/", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"ok":'));
        controller.enqueue(encoder.encode("true}"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  await tick();
  console.log("json", JSON.stringify(await started.json()));

  const bytes = new Response(ReadableStream.from([new Uint8Array([1, 2]), new Uint8Array([3])]));
  await tick();
  await tick();
  console.log("bytes", Array.from(await bytes.bytes()).join(","));
}

await main();
