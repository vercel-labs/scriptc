// A types-only SDK package declares the shape of JSON data as a class with
// fields only (`declare class UploadForm { url: string; fields: ... }`,
// with a merged namespace holding the fields interface). The program never
// constructs it: values arrive through JSON.parse or object literals, so
// they compile as records of the declared fields.
import type { UploadForm } from "upload-sdk";

interface Order {
  id: string;
  upload?: UploadForm;
  forms: UploadForm[];
}

function describe(form: UploadForm | undefined): string {
  if (!form) return "none";
  return `${form.url} ${form.fields.Policy} ${form.fields["X-Signature"]} ${form.fields["key"] ?? "-"} ${Object.keys(form.fields).join(",")}`;
}

const order = JSON.parse(
  '{"id":"o1","upload":{"url":"u","fields":{"Policy":"p","X-Signature":"s","key":"k"}},"forms":[]}',
) as Order;
console.log(order.id, describe(order.upload));
const made: UploadForm = { url: "v", fields: { Policy: "q", "X-Signature": "t" } };
order.forms.push(made);
made.fields.extra = "e";
console.log(describe(made), JSON.stringify(order.forms));
console.log(describe(undefined));
