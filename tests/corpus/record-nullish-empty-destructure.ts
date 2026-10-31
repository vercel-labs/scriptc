// `const { a, ...rest } = options ?? {}` (and `|| {}`): the pattern
// destructures either the options record or an empty object. Each key reads
// undefined from the empty object, a default applies to it, and the rest
// element packs the record's remaining own keys or nothing. The options
// expression is evaluated once.

interface EditorOptions {
  description: string;
  paddingX: number;
  label?: string;
}

function editor(options?: EditorOptions): string {
  const { description, ...editorOptions } = options ?? {};
  return `${description} ${JSON.stringify(editorOptions)} [${Object.keys(editorOptions).join(",")}]`;
}
console.log(editor());
console.log(editor({ description: "d", paddingX: 2 }));
console.log(editor({ description: "d", paddingX: 2, label: "l" }));

// Every member optional: the empty object is the same layout with every
// key absent.
interface StreamOptions {
  apiKey?: string;
  env?: string;
  signal?: string;
  transformHeaders?: (headers: string) => string;
}

function stream(options?: StreamOptions): string {
  const { transformHeaders, apiKey, ...rest } = options ?? {};
  const headers = transformHeaders ? transformHeaders("h") : "none";
  return `${headers} ${apiKey} ${JSON.stringify(rest)} ${"signal" in rest}`;
}
console.log(stream());
console.log(stream({ apiKey: "k", signal: "s" }));
console.log(stream({ transformHeaders: (h) => h + "!", env: "e" }));

// A nested optional record, renamed keys and a default.
interface Entry {
  options?: { deferred: boolean; signal?: string; step: number };
}

function submit(entry: Entry): string {
  const { deferred: _deferred, signal: _signal, step = -1, ...submission } = entry.options ?? {};
  return `${step} ${JSON.stringify(submission)}`;
}
console.log(submit({}));
console.log(submit({ options: { deferred: true, step: 4 } }));
console.log(submit({ options: { deferred: false, signal: "x", step: 0 } }));

// `||` and a null arm.
interface Retry {
  headers: string;
  retries: number;
}

function retry(value: Retry | null): string {
  const { headers, retries = 3 } = value || {};
  return `${headers} ${retries} ${typeof retries}`;
}
console.log(retry(null));
console.log(retry({ headers: "h", retries: 2 }));

// A generic options parameter.
function generic<TOptions extends { apiKey?: string; maxTokens: number }>(options?: TOptions): string {
  const { apiKey, ...providerOptions } = options ?? {};
  return `${apiKey} ${JSON.stringify(providerOptions)}`;
}
console.log(generic());
console.log(generic({ maxTokens: 3, apiKey: "k" }));

// The options expression runs once.
let calls = 0;
function current(): EditorOptions | undefined {
  calls++;
  return calls === 1 ? undefined : { description: "second", paddingX: 1 };
}
const { description: first } = current() ?? {};
const { description: second, paddingX } = current() ?? {};
console.log(first, second, paddingX, calls);

export {};
