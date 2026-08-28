// The adopted @types/node/undici declarations must route the same native
// AbortSignal and readable Web Streams surface as the shipped fallback.
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("typed stream"));
    controller.close();
  },
});

const init: RequestInit = {
  method: "POST",
  body,
  duplex: "half",
  redirect: "manual",
  signal: AbortSignal.timeout(100),
};

async function consume(url: string): Promise<number> {
  const response = await fetch(url, init);
  const headers = response.headers;
  headers.has("content-type");
  const reader = response.body!.getReader();
  const first = await reader.read();
  return first.done ? 0 : first.value.length;
}

async function reuseHeaders(url: string): Promise<void> {
  const response = await fetch(url);
  await fetch(url, { headers: response.headers });
}

async function retainBodyPromises(url: string): Promise<void> {
  const textResponse = await fetch(url);
  const text: Promise<string> = textResponse.text();
  const bytesResponse = await fetch(url);
  const bytes: Promise<Uint8Array> = bytesResponse.bytes();
  await text;
  await bytes;
}

void consume;
void reuseHeaders;
void retainBodyPromises;
