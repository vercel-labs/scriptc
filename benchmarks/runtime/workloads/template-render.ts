// Server-side HTML rendering: template literals, escaping, joins, and
// conditional fragments over a list of typed view models.
interface Product {
  id: number;
  title: string;
  description: string;
  price: number;
  tags: string[];
  inStock: boolean;
  rating: number;
}

let seed = 31337;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
const words = ["fast", "durable", "<b>bold</b>", "eco", '"quoted"', "light", "smart", "R&D", "classic", "modern"];
function sentence(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(words[Math.floor(random() * words.length)]!);
  return parts.join(" ");
}
function makeProducts(count: number): Product[] {
  const products: Product[] = [];
  for (let i = 0; i < count; i++) {
    products.push({
      id: i,
      title: sentence(3),
      description: sentence(20),
      price: Math.round(random() * 100000) / 100,
      tags: [words[i % words.length]!, words[(i * 7) % words.length]!],
      inStock: random() < 0.8,
      rating: Math.round(random() * 50) / 10,
    });
  }
  return products;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function stars(rating: number): string {
  let out = "";
  for (let i = 1; i <= 5; i++) out += i <= Math.round(rating) ? "*" : "-";
  return out;
}
function renderProduct(p: Product): string {
  const tags = p.tags.map((t) => `<li class="tag">${escapeHtml(t)}</li>`).join("");
  return `<article id="p-${p.id}" class="${p.inStock ? "in" : "out"}">
  <h2>${escapeHtml(p.title)}</h2>
  <p>${escapeHtml(p.description)}</p>
  <span class="price">$${p.price.toFixed(2)}</span>
  <span class="rating" title="${p.rating}">${stars(p.rating)}</span>
  <ul>${tags}</ul>
  ${p.inStock ? "<button>Add to cart</button>" : "<em>Sold out</em>"}
</article>`;
}
function renderPage(products: Product[], page: number): string {
  const body = products.map(renderProduct).join("\n");
  return `<!doctype html><html><head><title>Page ${page}</title></head><body>${body}</body></html>`;
}

const scale = Number(process.argv[2] ?? "1");
const products = makeProducts(Math.floor(2000 * scale));
let bytes = 0;
let hash = 0;
for (let page = 0; page < 10; page++) {
  const html = renderPage(products, page);
  bytes += html.length;
  for (let i = 0; i < html.length; i += 101) hash = (hash * 33 + html.charCodeAt(i)) % 2147483647;
}
console.log("bytes", bytes, "hash", hash);
