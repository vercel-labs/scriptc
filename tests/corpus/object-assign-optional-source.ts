// Object.assign into an index-signature record with an OPTIONAL source
// (Record | undefined): Node skips a nullish source, so the shared source
// still lands and the absent one contributes no keys. Both arms compared.
type Input = { type: "string" | "array" | "boolean"; description?: string };

function build(maybe: Record<string, Input> | undefined): Record<string, Input> {
  const inputs: Record<string, Input> = { own: { type: "boolean" } };
  const shared: Record<string, Input> = { b: { type: "array", description: "shared" } };
  Object.assign(inputs, maybe, shared);
  return inputs;
}

console.log(JSON.stringify(Object.keys(build(undefined)).sort()));
console.log(JSON.stringify(build({ a: { type: "string" } })));
console.log(JSON.stringify(build(undefined)["b"]));
console.log(JSON.stringify(build({ a: { type: "string" } })["a"]));
