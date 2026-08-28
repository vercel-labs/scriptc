const keepAlive = setInterval(() => {}, 1000);
const signal = AbortSignal.timeout(0);

signal.addEventListener("abort", () => {
  clearInterval(keepAlive);
  console.log("throwing abort listener");
  throw new Error("abort listener failed");
});

signal.addEventListener("abort", () => {
  console.log("later abort listener");
});
