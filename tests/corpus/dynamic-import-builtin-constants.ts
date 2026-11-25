// A baked constants read or destructure still evaluates its receiver: the
// receiver of `(await import("node:crypto")).constants.RSA_PKCS1_PADDING`
// is an awaited literal import, so the import runs where the expression is
// written and its microtask hop lands before the code that follows. The
// literal itself is the same value a named import of the member reads.
const order: string[] = [];
order.push("start");
void Promise.resolve().then(() => order.push("microtask"));

const padding = (await import("node:crypto")).constants.RSA_PKCS1_PADDING;
order.push("read");
console.log(padding, order.join(","));

// The destructured spelling over the awaited receiver: the declaration
// stores nothing, but its initializer still evaluates at that position.
void Promise.resolve().then(() => order.push("destructure-microtask"));
const { RSA_PKCS1_PADDING: paddingAlias } = (await import("node:crypto")).constants;
order.push("destructure");
console.log(paddingAlias, order.join(","));

// Every baked table follows the same rule, not just crypto's.
void Promise.resolve().then(() => order.push("http2-microtask"));
const { NGHTTP2_CANCEL } = (await import("node:http2")).constants;
order.push("http2");
console.log(NGHTTP2_CANCEL, order.join(","));

void Promise.resolve().then(() => order.push("zlib-microtask"));
const level: number = (await import("node:zlib")).constants.Z_NO_COMPRESSION;
order.push("zlib");
console.log(level, order.join(","));

// Inside an async function the await likewise evaluates at the statement,
// not after the function's own microtask queues up.
async function inside(): Promise<string> {
  const seen: string[] = [];
  void Promise.resolve().then(() => seen.push("inner-microtask"));
  const max = (await import("node:buffer")).constants.MAX_STRING_LENGTH;
  seen.push("inner-read");
  const { Z_BEST_COMPRESSION } = (await import("node:zlib")).constants;
  seen.push("inner-destructure");
  return `${max}:${Z_BEST_COMPRESSION}:${seen.join(",")}`;
}
console.log(await inside());

// A block-scoped declaration has the same shape.
{
  void Promise.resolve().then(() => order.push("block-microtask"));
  const { Z_DEFAULT_COMPRESSION } = (await import("node:zlib")).constants;
  order.push("block");
  console.log(Z_DEFAULT_COMPRESSION, order.join(","));
}
