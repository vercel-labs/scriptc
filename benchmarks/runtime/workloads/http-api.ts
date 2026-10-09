// A small JSON API server: routing, query parsing, a seeded product catalog,
// per-cart mutable state, typed JSON request bodies, conditional GETs, and
// request/response header handling. Driven by clients/http-load.mjs, which
// partitions carts per connection so every response is deterministic. The
// server reports its port on stderr (`PORT <n>`) and prints route totals
// after the client's POST /shutdown closes it.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

interface Product {
  id: number;
  sku: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  tags: string[];
  version: number;
}
interface CartLine {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
}
interface Cart {
  id: string;
  lines: CartLine[];
}
interface AddItem {
  productId: number;
  qty: number;
}
interface ProductPage {
  category: string;
  total: number;
  offset: number;
  items: ProductSummary[];
}
interface ProductSummary {
  id: number;
  name: string;
  price: number;
  inStock: boolean;
}
interface CartView {
  id: string;
  lines: CartLine[];
  count: number;
  total: number;
}
interface ApiError {
  error: string;
  status: number;
}

let seed = 2024;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const categories = ["books", "games", "garden", "kitchen", "music", "outdoor", "tools", "toys"];
const adjectives = ["red", "small", "classic", "smart", "eco", "deluxe", "basic", "pro"];
const products: Product[] = [];
const byCategory = new Map<string, Product[]>();
for (let i = 0; i < 2000; i++) {
  const category = categories[i % categories.length]!;
  const product: Product = {
    id: i,
    sku: "sku-" + (100000 + i),
    name: adjectives[Math.floor(random() * adjectives.length)]! + " " + category + " item " + i,
    category,
    price: Math.round(100 + random() * 9900) / 100,
    stock: Math.floor(random() * 40),
    tags: random() < 0.3 ? ["sale", category] : [category],
    version: 1,
  };
  products.push(product);
  let list = byCategory.get(category);
  if (list === undefined) {
    list = [];
    byCategory.set(category, list);
  }
  list.push(product);
}

const carts = new Map<string, Cart>();
const routeCounts = new Map<string, number>();
let requests = 0;

function count(route: string): void {
  routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const requestId = req.headers["x-request-id"];
  if (requestId !== undefined) res.setHeader("x-request-id", requestId);
  res.end(body);
}

function fail(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  const error: ApiError = { error: message, status };
  send(req, res, status, JSON.stringify(error));
}

function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  if (query === "") return params;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) params.set(decodeURIComponent(pair), "");
    else params.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)));
  }
  return params;
}

function intParam(params: Map<string, string>, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === undefined) return fallback;
  const value = parseInt(raw, 10);
  return Number.isNaN(value) || value < 0 ? fallback : value;
}

function listProducts(req: IncomingMessage, res: ServerResponse, query: string): void {
  const params = parseQuery(query);
  const category = params.get("category") ?? "";
  const source = category === "" ? products : (byCategory.get(category) ?? []);
  const minPrice = intParam(params, "minPrice", 0);
  const offset = intParam(params, "offset", 0);
  const limit = Math.min(intParam(params, "limit", 20), 50);
  const matching = source.filter((p) => p.price >= minPrice);
  const page: ProductPage = {
    category: category === "" ? "all" : category,
    total: matching.length,
    offset,
    items: matching.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      inStock: p.stock > 0,
    })),
  };
  send(req, res, 200, JSON.stringify(page));
}

function getProduct(req: IncomingMessage, res: ServerResponse, idText: string): void {
  const id = parseInt(idText, 10);
  if (Number.isNaN(id) || id < 0 || id >= products.length) {
    fail(req, res, 404, "product " + idText + " not found");
    return;
  }
  const product = products[id]!;
  const etag = '"p' + product.id + "-v" + product.version + '"';
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.setHeader("etag", etag);
    res.end();
    return;
  }
  res.setHeader("etag", etag);
  send(req, res, 200, JSON.stringify(product));
}

function viewCart(cart: Cart): string {
  let count = 0;
  let total = 0;
  for (const line of cart.lines) {
    count += line.qty;
    total += line.qty * line.unitPrice;
  }
  const view: CartView = {
    id: cart.id,
    lines: cart.lines,
    count,
    total: Math.round(total * 100) / 100,
  };
  return JSON.stringify(view);
}

function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return auth !== undefined && auth.startsWith("Bearer ") && auth.length > 12;
}

function addToCart(req: IncomingMessage, res: ServerResponse, cartId: string, body: string): void {
  if (!authorized(req)) {
    fail(req, res, 401, "missing or invalid token");
    return;
  }
  const contentType = req.headers["content-type"];
  if (contentType === undefined || !contentType.startsWith("application/json")) {
    fail(req, res, 415, "expected application/json");
    return;
  }
  let item: AddItem;
  try {
    item = JSON.parse(body) as AddItem;
  } catch {
    fail(req, res, 400, "malformed JSON body");
    return;
  }
  if (item.productId < 0 || item.productId >= products.length || item.qty <= 0) {
    fail(req, res, 422, "invalid item");
    return;
  }
  const product = products[item.productId]!;
  let cart = carts.get(cartId);
  if (cart === undefined) {
    cart = { id: cartId, lines: [] };
    carts.set(cartId, cart);
  }
  const existing = cart.lines.find((line) => line.sku === product.sku);
  if (existing !== undefined) existing.qty += item.qty;
  else cart.lines.push({ sku: product.sku, name: product.name, qty: item.qty, unitPrice: product.price });
  send(req, res, 201, viewCart(cart));
}

function removeFromCart(req: IncomingMessage, res: ServerResponse, cartId: string, sku: string): void {
  if (!authorized(req)) {
    fail(req, res, 401, "missing or invalid token");
    return;
  }
  const cart = carts.get(cartId);
  const index = cart === undefined ? -1 : cart.lines.findIndex((line) => line.sku === sku);
  if (cart === undefined || index < 0) {
    fail(req, res, 404, "line " + sku + " not in cart " + cartId);
    return;
  }
  cart.lines.splice(index, 1);
  res.statusCode = 204;
  res.end();
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  requests++;
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q + 1);
  const parts = path.split("/").filter((s) => s !== "");

  if (method === "GET" && path === "/health") {
    count("health");
    send(req, res, 200, '{"ok":true}');
  } else if (method === "GET" && path === "/products") {
    count("list");
    listProducts(req, res, query);
  } else if (method === "GET" && parts.length === 2 && parts[0] === "products") {
    count("product");
    getProduct(req, res, parts[1]!);
  } else if (method === "GET" && parts.length === 2 && parts[0] === "carts") {
    count("cart");
    const cart = carts.get(parts[1]!);
    if (cart === undefined) fail(req, res, 404, "cart " + parts[1]! + " not found");
    else send(req, res, 200, viewCart(cart));
  } else if (method === "POST" && parts.length === 3 && parts[0] === "carts" && parts[2] === "items") {
    count("add");
    addToCart(req, res, parts[1]!, body);
  } else if (method === "DELETE" && parts.length === 4 && parts[0] === "carts" && parts[2] === "items") {
    count("remove");
    removeFromCart(req, res, parts[1]!, parts[3]!);
  } else if (method === "POST" && path === "/shutdown") {
    send(req, res, 200, '{"bye":true}');
    server.close(() => {
      let lines = 0;
      let units = 0;
      for (const cart of carts.values()) {
        lines += cart.lines.length;
        for (const line of cart.lines) units += line.qty;
      }
      const names = [...routeCounts.keys()].sort();
      console.log("requests " + requests);
      for (const name of names) console.log("  " + name + " " + routeCounts.get(name)!);
      console.log("carts " + carts.size + " lines " + lines + " units " + units);
    });
  } else {
    count("unmatched");
    fail(req, res, 404, "no route for " + method + " " + path);
  }
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => handle(req, res, body));
});

server.listen(0, "127.0.0.1", () => {
  process.stderr.write("PORT " + server.address().port + "\n");
});
