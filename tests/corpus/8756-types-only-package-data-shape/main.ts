// A types-only package has no implementation to compile or to island: an
// `import type` from it names data the program itself builds. A recursive
// JSON document shape (an index-signature interface that refers back to
// the union) has no native record layout, so the value is held as the
// checked-dynamic value — the same answer `unknown` gets — instead of
// refusing and blaming the package.
import type { DocumentEnvelope, DocumentType } from "doc-types-pkg";

function sanitize(value: unknown): DocumentType {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitize(nested)]));
  }
  return value as DocumentType;
}

function envelope(body: DocumentType): DocumentEnvelope {
  return { body };
}

const source = { title: "a", tags: ["x", "y"], meta: { depth: 2 }, empty: null };
const clean = sanitize(source);
console.log(JSON.stringify(clean));
console.log(JSON.stringify(envelope(clean)));
const parsed = JSON.parse('{"n":1,"list":[true,null]}') as unknown as DocumentType;
console.log(JSON.stringify(sanitize(parsed)), typeof sanitize(parsed));
