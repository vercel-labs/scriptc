const keepAlive = setInterval(() => {}, 1000);
const signal = AbortSignal.timeout(0);

try {
  signal.removeEventListener();
} catch (error) {
  console.log("removeEventListener arity:", error.name);
}

signal.addEventListener("abort", []);
signal.addEventListener("abort", Buffer.from([]));
console.log("registered object-shaped abort listeners");

signal.addEventListener("abort", { handleEvent: 1 });
console.log("registered non-callable abort listener");

signal.addEventListener("abort", () => {
  clearInterval(keepAlive);
  console.log("later abort listener");
});

export {};
