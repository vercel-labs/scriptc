const parts: Uint8Array[] = [];
parts[1] = Buffer.from("b");

try {
  Buffer.concat(parts);
} catch {
  console.log("caught sparse concat item");
}
