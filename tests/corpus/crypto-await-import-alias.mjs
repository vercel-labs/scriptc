// Destructuring the SubtleCrypto object from an awaited literal import keeps
// the import's microtask hop; method calls on the binding lower as
// crypto.subtle's own.
const order = [];
Promise.resolve().then(() => order.push("microtask"));
order.push("before");
const { subtle } = await import("node:crypto");
order.push("after");
console.log(order.join(","));
console.log("digest", new Uint8Array(await subtle.digest("SHA-256", Buffer.from("x"))).byteLength);
