// @exit: 1
console.log("before pending with rejection");
void Promise.reject(new Error("unhandled wins"));
await new Promise<void>(() => {});
console.log("unreachable");

export {};
