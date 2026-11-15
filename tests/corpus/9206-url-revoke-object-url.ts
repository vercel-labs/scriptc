// URL.revokeObjectURL(id): the id is coerced to a string and then looked
// up. A compiled program registers no blob URLs, so every id misses and
// the call answers undefined without throwing. (The zero-argument
// ERR_MISSING_ARGS contract is pinned by 2573-fs-url-arg-ladders.cjs.)
URL.revokeObjectURL("blob:nodedata:never-registered");
URL.revokeObjectURL(new URL("https://example.com/x"));

// The call still evaluates its argument before returning.
let calls = 0;
const text = (): string => {
  calls++;
  return "blob:made";
};
URL.revokeObjectURL(text());
URL.revokeObjectURL(text());
console.log("calls", calls);

const id = "blob:" + "x";
URL.revokeObjectURL(id);
console.log("survived", typeof id);
