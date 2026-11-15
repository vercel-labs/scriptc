import { parse, stringify } from "yaml";

const text = `
name: storefront
region: iad1
services:
  - name: api
    replicas: 3
    env: { LOG: debug, PORT: "8080" }
  - name: worker
    replicas: 1
    tags: [batch, nightly]
`;
const doc = parse(text) as { name: string; services: Array<{ name: string; replicas: number }> };
console.log(doc.name, doc.services.length, doc.services.map((s) => `${s.name}x${s.replicas}`).join(","));
console.log(stringify({ a: 1, b: [true, null, "x"], c: { d: "multi\nline" } }).trim());
