// An async request handler: each request tokenizes a JSON body, awaits (as
// if reading more of it), parses the tokens into a syntax tree whose nodes
// point back at their tokens, awaits again (as if loading reference data),
// validates the tree into issues held in an index, and renders a response.
// Requests run in batches of concurrent handlers, so the handlers of one
// batch interleave at every await.
//
//   requests <requests> <concurrency> <items-per-body> [plain]
//
// Each request runs in its own LifetimeRegion, released when its response
// is rendered; `plain` never constructs a region.
import { readFileSync } from "node:fs";
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

const T_PUNCT = 0;
const T_STR = 1;
const T_NUM = 2;
const T_WORD = 3;

class Token implements ProgramLifetime {
  readonly kind: number;
  readonly text: string;
  readonly pos: number;
  constructor(kind: number, text: string, pos: number) {
    this.kind = kind;
    this.text = text;
    this.pos = pos;
  }
}

const N_OBJECT = 0;
const N_ARRAY = 1;
const N_STRING = 2;
const N_NUMBER = 3;
const N_LITERAL = 4;

class JsonNode implements ProgramLifetime {
  readonly kind: number;
  readonly token: Token;
  parent: JsonNode | undefined = undefined;
  readonly keys: string[] = [];
  readonly children: JsonNode[] = [];
  constructor(kind: number, token: Token) {
    this.kind = kind;
    this.token = token;
  }
}

class Issue implements ProgramLifetime {
  readonly path: string;
  readonly node: JsonNode;
  readonly message: string;
  constructor(path: string, node: JsonNode, message: string) {
    this.path = path;
    this.node = node;
    this.message = message;
  }
}

// ---- request bodies (deterministic) ----

function body(id: number, items: number): string {
  let seed = 7 + id * 7919;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const parts: string[] = [];
  for (let i = 0; i < items; i++) {
    const qty = rand(12) - 1;
    const sku = rand(9) === 0 ? "" : `sku-${rand(5000)}`;
    const tags = Array.from({ length: rand(4) }, (_, k) => `"t${k}${rand(10)}"`).join(",");
    parts.push(`{"sku":"${sku}","qty":${qty},"price":${rand(10000) / 100},"gift":${rand(2) === 0},"tags":[${tags}]}`);
  }
  return `{"order":${id},"customer":"c${id % 97}","items":[${parts.join(",")}]}`;
}

// ---- handler ----

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const start = i;
    if (c === 34) {
      i++;
      while (text.charCodeAt(i) !== 34) i++;
      i++;
      tokens.push(new Token(T_STR, text.slice(start + 1, i - 1), start));
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      i++;
      while (i < text.length && (text.charCodeAt(i) === 46 || (text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57))) i++;
      tokens.push(new Token(T_NUM, text.slice(start, i), start));
    } else if (c >= 97 && c <= 122) {
      while (i < text.length && text.charCodeAt(i) >= 97 && text.charCodeAt(i) <= 122) i++;
      tokens.push(new Token(T_WORD, text.slice(start, i), start));
    } else {
      i++;
      tokens.push(new Token(T_PUNCT, text[start]!, start));
    }
  }
  return tokens;
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  value(): JsonNode {
    const token = this.tokens[this.at++]!;
    if (token.kind === T_STR) return new JsonNode(N_STRING, token);
    if (token.kind === T_NUM) return new JsonNode(N_NUMBER, token);
    if (token.kind === T_WORD) return new JsonNode(N_LITERAL, token);
    const node = new JsonNode(token.text === "{" ? N_OBJECT : N_ARRAY, token);
    const close = token.text === "{" ? "}" : "]";
    while (this.tokens[this.at]!.text !== close) {
      if (node.kind === N_OBJECT) {
        node.keys.push(this.tokens[this.at]!.text);
        this.at += 2; // the key and the colon
      }
      const child = this.value();
      child.parent = node;
      node.children.push(child);
      if (this.tokens[this.at]!.text === ",") this.at++;
    }
    this.at++;
    return node;
  }
}

function member(node: JsonNode, key: string): JsonNode | undefined {
  const i = node.keys.indexOf(key);
  return i < 0 ? undefined : node.children[i];
}

function validate(root: JsonNode, issues: Issue[], index: Map<string, JsonNode>): number {
  let total = 0;
  const items = member(root, "items")!;
  for (let i = 0; i < items.children.length; i++) {
    const item = items.children[i]!;
    const path = `items[${i}]`;
    const sku = member(item, "sku")!;
    if (sku.token.text === "") issues.push(new Issue(`${path}.sku`, sku, "empty sku"));
    else if (index.has(sku.token.text)) issues.push(new Issue(`${path}.sku`, sku, `duplicate of ${index.get(sku.token.text)!.token.pos}`));
    else index.set(sku.token.text, item);
    const qty = Number(member(item, "qty")!.token.text);
    if (qty <= 0) issues.push(new Issue(`${path}.qty`, member(item, "qty")!, "quantity must be positive"));
    else total += qty * Number(member(item, "price")!.token.text);
    const tags = member(item, "tags")!;
    for (const tag of tags.children) if (tag.token.text.endsWith("0")) issues.push(new Issue(`${path}.tags`, tag, "reserved tag"));
  }
  return total;
}

const hop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function handle(text: string): Promise<string> {
  const tokens = tokenize(text);
  await hop();
  const root = new Parser(tokens).value();
  await hop();
  const issues: Issue[] = [];
  const index = new Map<string, JsonNode>();
  const total = validate(root, issues, index);
  await hop();
  const first = issues[0];
  return `${member(root, "order")!.token.text} ${tokens.length} ${index.size} ${issues.length} ${total.toFixed(2)}` +
    (first === undefined ? "" : ` ${first.path}@${first.node.token.pos}`);
}

// ---- driver ----

function rssMb(key: string): number {
  const m = new RegExp(`${key}:\\s*(\\d+) kB`).exec(readFileSync("/proc/self/status", "utf8"));
  return m === null ? 0 : Number(m[1]) / 1024;
}

const args = process.argv.slice(2);
const requests = Number(args[0] ?? "4000");
const concurrency = Number(args[1] ?? "16");
const items = Number(args[2] ?? "100");
const useRegions = args[3] !== "plain";

async function serve(id: number): Promise<string> {
  const text = body(id, items);
  if (!useRegions) return await handle(text);
  const region = new LifetimeRegion();
  const response = await region.run(() => handle(text));
  region.release();
  return response;
}

async function main(): Promise<void> {
  let hash = 0;
  let lines = 0;
  let sample = "";
  let rssFirst = 0;
  const t0 = performance.now();
  for (let next = 0; next < requests; next += concurrency) {
    const batch: Promise<string>[] = [];
    for (let k = next; k < next + concurrency && k < requests; k++) batch.push(serve(k));
    for (const response of await Promise.all(batch)) {
      for (let i = 0; i < response.length; i++) hash = (hash * 31 + response.charCodeAt(i)) % 1000000007;
      lines++;
      if (lines === 1) sample = response;
    }
    if (next === 0) rssFirst = rssMb("VmRSS");
  }
  const ms = performance.now() - t0;
  console.log(`${lines} responses, hash ${hash}, first ${sample}`);
  console.log(
    `total ${ms.toFixed(1)} ms per-request ${((ms * 1000) / requests).toFixed(1)} us` +
      ` rss-first ${rssFirst.toFixed(1)} MB rss-last ${rssMb("VmRSS").toFixed(1)} MB peak ${rssMb("VmHWM").toFixed(1)} MB`,
  );
}

main();
