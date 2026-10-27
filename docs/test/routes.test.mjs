import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { description, siteUrl } from "../src/lib/site.ts";

const base = process.env.DOCS_TEST_URL;
assert.ok(base, "Set DOCS_TEST_URL to a running production build.");
const pages = JSON.parse(await readFile(new URL("./fixtures/migration-baseline.json", import.meta.url), "utf8"));
const get = (path, headers = {}) => fetch(new URL(path, base), {
  redirect: "manual",
  signal: AbortSignal.timeout(30_000),
  headers: { "user-agent": "Mozilla/5.0", accept: "text/html", ...headers },
});
const decode = (text) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** A page's MDX with its `<include>` partials inlined. */
const pageSource = async (file) => {
  const url = new URL(`../content/docs/${file}.mdx`, import.meta.url);
  const source = await readFile(url, "utf8");
  const parts = [];
  for (const line of source.split("\n")) {
    const include = line.match(/^<include>([^<]+\.mdx)<\/include>$/);
    parts.push(include ? await readFile(new URL(include[1], url), "utf8") : line);
  }
  return parts.join("\n");
};
const meta = (html, key) => decode(html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1] ?? "");

for (const { href, title, headings } of pages) {
  test(`${href} preserves its title, social card and published heading anchors`, async () => {
    const response = await get(href);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""), `${title} | scriptc`);
    assert.equal(meta(html, "description"), description);
    assert.equal(meta(html, "og:title"), `${title} | scriptc`);
    assert.ok(html.includes(`<link rel="canonical" href="${siteUrl}${href}"`));
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.ok(html.includes('data-geistdocs-article="title"'));
    assert.ok(html.includes('data-geistdocs-article="body"'));
    for (const heading of headings) assert.ok(html.includes(`id="${heading.id}"`), `missing anchor ${heading.id}`);
  });
}

test("previous docs URLs redirect permanently and preserve query parameters", async () => {
  for (const { legacy, href } of pages) {
    // Pages added after the migration have no previous URL.
    if (legacy === undefined) continue;
    const response = await get(`${legacy}?mode=static`);
    assert.equal(response.status, 308, legacy);
    const destination = new URL(response.headers.get("location"), base);
    assert.equal(destination.pathname, href);
    assert.equal(destination.search, "?mode=static");
  }
  assert.equal((await get("/docs/introduction")).headers.get("location"), "/docs");
});

test("Markdown twins preserve examples and declare the HTML canonical URL", async () => {
  for (const { href } of pages) {
    const response = await get(`${href}.md`);
    assert.equal(response.status, 200, href);
    assert.match(response.headers.get("content-type"), /^text\/markdown/);
    assert.ok(response.headers.get("link")?.includes(`<${siteUrl}${href}>; rel="canonical"`));
    const markdown = await response.text();
    const file = href === "/docs" ? "index" : href.slice("/docs/".length);
    const source = await pageSource(file);
    for (const fence of source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
      assert.ok(markdown.includes(fence[1].trimEnd()), `${file} lost a code example`);
    }
    assert.doesNotMatch(markdown, /className=/);
  }
  const mdx = await get("/docs/quickstart.mdx");
  assert.equal(mdx.status, 200);
  assert.match(mdx.headers.get("content-type"), /^text\/markdown/);
});

test("literal HTML tables and definition lists remain readable", async () => {
  const coverage = await (await get("/docs/coverage")).text();
  assert.match(coverage, /<table[ >]/);
  const cli = await (await get("/docs/cli")).text();
  assert.match(cli, /<dl[ >]/);
  assert.match(cli, /<dt[ >]/);
  const markdown = await (await get("/docs/cli.md")).text();
  assert.ok(!markdown.includes("--dynamic"));
  assert.ok(markdown.includes("--external-types"));
});

test("docs negotiate Markdown and keep browser HTML and prefetch payloads", async () => {
  for (const headers of [{ accept: "text/markdown" }, { "user-agent": "ClaudeBot/1.0", accept: "*/*" }]) {
    const response = await get("/docs/quickstart", headers);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/markdown/);
    await response.body?.cancel();
  }
  const html = await get("/docs/quickstart");
  assert.match(html.headers.get("content-type"), /^text\/html/);
  await html.body?.cancel();
  // Next.js can add its _rsc hash with a redirect before returning the payload.
  const prefetch = await fetch(new URL("/docs/quickstart", base), {
    signal: AbortSignal.timeout(30_000),
    headers: { rsc: "1", "next-router-prefetch": "1", accept: "*/*", "user-agent": "ClaudeBot/1.0" },
  });
  assert.equal(prefetch.status, 200);
  assert.doesNotMatch(prefetch.headers.get("content-type"), /markdown/);
  await prefetch.body?.cancel();
});

test("unknown pages return 404 in HTML and Markdown", async () => {
  for (const path of ["/docs/missing-page", "/docs/missing-page.md", "/missing-page"]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    await response.body?.cancel();
  }
});

test("agent and search indexes include every documentation page", async () => {
  const llms = await (await get("/llms.txt")).text();
  const sitemapMarkdown = await (await get("/sitemap.md")).text();
  const sitemap = await (await get("/sitemap.xml")).text();
  for (const { href } of pages) {
    assert.ok(llms.includes(`${siteUrl}${href}`), `llms.txt lacks ${href}`);
    assert.ok(sitemapMarkdown.includes(href), `sitemap.md lacks ${href}`);
    assert.ok(sitemap.includes(`<loc>${siteUrl}${href}</loc>`), `sitemap.xml lacks ${href}`);
  }
  const agents = await (await get("/agents.md")).text();
  assert.ok(agents.includes("scriptc"));
  assert.ok(agents.includes("/compatibility"));
  const search = await get("/api/search?query=runtime%20type%20checks");
  assert.equal(search.status, 200);
  assert.ok((await search.json()).some((result) => result.url === "/docs/limitations#runtime-type-checks"));
});

test("internal documentation links and their fragments resolve", async () => {
  const anchors = new Map();
  for (const { href } of pages) anchors.set(href, await (await get(href)).text());
  for (const { href } of pages) {
    const file = href === "/docs" ? "index" : href.slice("/docs/".length);
    const source = await pageSource(file);
    for (const [, path, fragment] of source.matchAll(/\]\((\/docs(?:\/[\w-]+)?)(?:#([\w-]+))?\)/g)) {
      assert.ok(anchors.has(path), `${href} links to missing page ${path}`);
      if (fragment) assert.ok(anchors.get(path).includes(`id="${fragment}"`), `${href} links to missing fragment ${path}#${fragment}`);
    }
  }
});

test("compatibility page and data endpoints keep their existing contracts", async () => {
  const page = await get("/compatibility");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Node.js 24 Compatibility"));
  assert.ok(html.includes(`<link rel="canonical" href="${siteUrl}/compatibility"`));
  const response = await get("/compatibility/data");
  assert.equal(response.status, 200);
  const dataset = await response.json();
  const artifact = JSON.parse(await readFile(new URL("../src/generated/node-v24-compatibility.json", import.meta.url), "utf8"));
  assert.equal(dataset.rows.length, artifact.rows.length);
  // The row count next.config.mjs derives reaches the page (React separates
  // adjacent text nodes with empty comments).
  assert.ok(html.replaceAll("<!-- -->", "").includes(`Loading ${artifact.rows.length.toLocaleString()} Node.js API rows`));
  assert.equal((await get("/node-compatibility")).status, 308);
  assert.equal((await get("/node-compatibility/data")).status, 308);
});

test("WebMCP serves its bridge and discovery manifest", async () => {
  const response = await get("/api/mcp?webmcp-script");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(await response.text(), /registerTool/);
  const manifest = await get("/.well-known/mcp.json");
  assert.equal(manifest.status, 200);
  assert.ok((await manifest.json()).servers.some((server) => server.url.endsWith("/api/mcp")));
});

test("homepage negotiates the agent profile and preserves explicit HTML requests", async () => {
  for (const headers of [{ accept: "text/markdown" }, { "user-agent": "ClaudeBot/1.0", accept: "*/*" }]) {
    const response = await get("/", headers);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/markdown/);
    assert.ok((await response.text()).includes("/compatibility"));
  }
  const html = await get("/", { "user-agent": "ClaudeBot/1.0", accept: "text/html" });
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /^text\/html/);
  await html.body?.cancel();
});

test("homepage and existing social images still render", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes('href="/docs/quickstart"'));
  assert.ok(html.includes("832040"));
  assert.doesNotMatch(html, /~320KB|~620KB|about 4ms|~35ms/);
  for (const path of ["/og", "/og/limitations"]) {
    const image = await get(path);
    assert.equal(image.status, 200, path);
    assert.match(image.headers.get("content-type"), /^image\/png/);
    await image.body?.cancel();
  }
});
