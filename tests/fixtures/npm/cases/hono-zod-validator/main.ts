// A Hono app validated by @hono/zod-validator and zod 4.6, all compiled
// from their JavaScript: `c.req.valid(target)` hands the handler the
// parsed value, typed by the schema's z.infer through hono's declarations.
// Requests go through app.request, so no socket is involved.
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";

const Book = z.strictObject({
  title: z.string().trim().min(1),
  year: z.number().int().min(1450),
  tags: z.array(z.string()).max(4).default([]),
  rating: z.number().min(0).max(5).optional(),
});
type Book = z.infer<typeof Book>;
const ListQuery = z.object({
  minYear: z.coerce.number().int().optional(),
  sort: z.enum(["title", "year"]).default("title"),
  limit: z.coerce.number().int().min(1).max(10).default(3),
});
const IdParam = z.object({ id: z.string().regex(/^b\d+$/) });

// Failed checks answer with the issues' paths and codes.
const reject = (
  result: { success: true } | { success: false; error: z.core.$ZodError },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const paths = result.error.issues.map((i) => `${i.path.join(".")}:${i.code}`);
  return c.json({ error: "invalid", paths }, 400);
};

const books = new Map<string, Book>();
let nextId = 1;

const app = new Hono();
app.post(
  "/books",
  zValidator("json", Book, (result, c) => {
    if (!result.success) {
      const paths = result.error.issues.map((i) => `${i.path.join(".")}:${i.code}`);
      return c.json({ error: "invalid", paths }, 400);
    }
  }),
  (c) => {
    const book = c.req.valid("json");
    book.tags.push("new");
    const id = `b${nextId++}`;
    books.set(id, book);
    const score = (book.rating ?? 0) * 2 + book.tags.length;
    return c.json({ id, title: book.title.toUpperCase(), year: book.year, score }, 201);
  },
);
app.get("/books", zValidator("query", ListQuery, reject), (c) => {
  const { minYear, sort, limit } = c.req.valid("query");
  const rows = [...books.values()]
    .filter((b) => minYear === undefined || b.year >= minYear)
    .sort((a, b) => (sort === "year" ? a.year - b.year : a.title < b.title ? -1 : 1))
    .slice(0, limit)
    .map((b) => `${b.title}/${b.year}`);
  return c.json({ sort, limit, rows });
});
app.get("/books/:id", zValidator("param", IdParam, reject), (c) => {
  const id = c.req.valid("param").id;
  const book = books.get(id);
  if (book === undefined) return c.json({ error: "missing", id }, 404);
  return c.json({ id, ...book });
});

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await app.request(path, init);
  console.log(method, path, res.status, await res.text());
}

async function main(): Promise<void> {
  await call("POST", "/books", { title: "  Dune ", year: 1965, tags: ["sf"], rating: 4.5 });
  await call("POST", "/books", { title: "Emma", year: 1815 });
  await call("POST", "/books", { title: "Ulysses", year: 1922, tags: ["modern"] });
  await call("POST", "/books", { title: "", year: 1200, extra: true });
  await call("POST", "/books", { title: "Bad", year: "x", tags: [1, 2, 3, 4, 5] });
  await call("GET", "/books");
  await call("GET", "/books?minYear=1900&sort=year&limit=5");
  await call("GET", "/books?limit=99");
  await call("GET", "/books/b2");
  await call("GET", "/books/b9");
  await call("GET", "/books/nope");
  const kept = books.get("b1")!;
  console.log("stored", kept.tags.join(","), kept.title);
}

void main();
