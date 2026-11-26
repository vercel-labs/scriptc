// A checked cast of parsed JSON accepts an absent optional field in every
// shape the cast builds: scalar and nullable members, a nested record, an
// array of records, an index-signature dictionary, and each arm of a
// discriminated union. Node erases the assertion, so the compiled program
// must answer the same undefined reads.
interface Scalar {
  host: string;
  port?: number;
  note?: string | null;
}
interface Nested {
  inner: { a: string; b?: number };
  list?: { id: number; label?: string }[];
}
interface Dict {
  [key: string]: string | number | undefined;
  host: string;
  port?: number;
}
type Message = { kind: "text"; text: string; note?: string } | { kind: "num"; value: number };

const scalar = JSON.parse('{"host":"h"}') as Scalar;
console.log(scalar.host, scalar.port === undefined, scalar.note === undefined);

const nested = JSON.parse('{"inner":{"a":"x"}}') as Nested;
console.log(nested.inner.a, nested.inner.b === undefined, nested.list === undefined);

const listed = JSON.parse(
  '{"inner":{"a":"y","b":2},"list":[{"id":1},{"id":2,"label":"b"}]}',
) as Nested;
console.log(
  listed.inner.b,
  listed.list!.length,
  listed.list![0]!.label === undefined,
  listed.list![1]!.label,
);

const dict = JSON.parse('{"host":"h","port":8080}') as Dict;
console.log(dict.host, dict.port, dict.missing === undefined);

for (const text of ['{"kind":"text","text":"hi"}', '{"kind":"num","value":3}']) {
  const message = JSON.parse(text) as Message;
  if (message.kind === "text") console.log("text", message.text, message.note === undefined);
  else console.log("num", message.value);
}
