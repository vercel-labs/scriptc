// A body method the program replaces on a Response answers the own property,
// as Node answers it: the assignment shadows the prototype method, the native
// body stays unread, a non-function own property fails the call by name, and
// deleting the property restores the prototype method. A computed key and an
// Object.assign source add the same own property, and a call that names its
// member through that computed key answers it.
const describe = (e: any): string => `${String(e?.name)}: ${String(e?.message)}`;

async function main(): Promise<void> {
  const res = new Response('{"native":true}');
  (res as any).json = async () => ({ own: true });
  console.log("json", JSON.stringify(await res.json()), res.bodyUsed);
  delete (res as any).json;
  console.log("json restored", JSON.stringify(await res.json()), res.bodyUsed);

  const text = new Response("native text");
  (text as any).text = async () => "own text";
  console.log("text", await text.text(), text.bodyUsed);

  const bytes = new Response("native bytes");
  (bytes as any).bytes = async () => new Uint8Array([7]);
  console.log("bytes", (await bytes.bytes())[0], bytes.bodyUsed);

  const buffer = new Response("native buffer");
  (buffer as any).arrayBuffer = async () => new Uint8Array([9]).buffer;
  console.log("arrayBuffer", (await buffer.arrayBuffer()).byteLength, buffer.bodyUsed);

  const notFunction = new Response("body");
  (notFunction as any).text = 42;
  try {
    await notFunction.text();
  } catch (e) {
    console.log("not a function", describe(e), notFunction.bodyUsed);
  }

  const key = "json";
  const computed = new Response('{"native":1}');
  (computed as any)[key] = async () => ({ computed: true });
  console.log("computed", JSON.stringify(await computed.json()), computed.bodyUsed);

  // The call names its member through the same computed key the write used, so
  // the element-access dispatch answers the own property too.
  (computed as any)[key] = async () => ({ element: true });
  console.log("element", JSON.stringify(await (computed as any)[key]()), computed.bodyUsed);

  const assigned = new Response('{"native":2}');
  Object.assign(assigned, { json: async () => ({ assigned: true }) });
  console.log("assigned", JSON.stringify(await assigned.json()), assigned.bodyUsed);

  const untouched = new Response('{"native":3}');
  console.log("untouched", JSON.stringify(await untouched.json()), untouched.bodyUsed);
}

main();
