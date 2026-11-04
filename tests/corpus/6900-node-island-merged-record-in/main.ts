// @requires-libnode
// A merged generic record crossing INTO the island (`object<T>(properties)`
// is `Type.Object(props)`): the merged type is an intersection — the base's
// fields without one, plus the overrides — and the island reads the
// program's own object, not a copy of it.
import { keys, object } from "recordkit";

interface ProviderBase {
  name: string;
  retries: number;
}

interface ProviderOverrides {
  stream: boolean;
}

/** A merged record spelled as an intersection of a mapped type and an interface. */
type MergedProvider = Omit<ProviderBase, "retries"> & ProviderOverrides;

function merged(name: string, stream: boolean): MergedProvider {
  return { name, stream };
}

const props: MergedProvider = merged("openai", true);
const schema = object(props);
console.log(schema.kind, schema.describe());
console.log(keys(props), keys(schema.properties));
console.log(schema.properties.name, schema.properties.stream);

const inline = object({ name: "anthropic", stream: false });
console.log(inline.kind, inline.describe(), inline.properties.name);
