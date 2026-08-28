// @dynamic
try {
  await import("./a.ts");
  console.log("outer ok");
} catch {
  console.log("outer rejected");
}

export {};
