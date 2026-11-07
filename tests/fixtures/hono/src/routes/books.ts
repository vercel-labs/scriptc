/* Catalogue routes: list with filters, sorting and pagination; read with
 * entity tags; create, replace, patch and delete; NDJSON export. */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { etag } from "hono/etag";
import { stream } from "hono/streaming";
import type { Book } from "../domain.ts";
import { canonicalQuery, collectionTag, entityTag, expectedVersion } from "../http.ts";
import { rejectInvalid, requireScope, type AppEnv } from "../middleware.ts";
import { bookDraftSchema, bookListQuerySchema, bookPatchSchema, idParamSchema } from "../schemas.ts";
import type { LibraryService } from "../service.ts";

function summary(book: Book) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    genre: book.genre,
    year: book.year,
    rating: book.rating,
  };
}

export function bookRoutes(service: LibraryService) {
  const routes = new Hono<AppEnv>();
  routes.use("*", etag());

  routes.get("/", zValidator("query", bookListQuerySchema, rejectInvalid), async (c) => {
    const query = c.req.valid("query");
    const page = await service.listBooks(query);
    c.header("ETag", collectionTag("books", service.books.revision, canonicalQuery(c.req.url)));
    c.header("Cache-Control", "private, max-age=0, must-revalidate");
    return c.json({
      items: page.items.map(summary),
      page: { offset: page.offset, limit: page.limit, total: page.total, nextOffset: page.nextOffset },
    });
  });

  routes.get("/export", zValidator("query", bookListQuerySchema, rejectInvalid), async (c) => {
    const query = c.req.valid("query");
    const page = await service.listBooks({ ...query, offset: 0, limit: Number.MAX_SAFE_INTEGER });
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("X-Total-Count", String(page.total));
    return stream(c, async (out) => {
      const batch: string[] = [];
      for (const book of page.items) {
        batch.push(JSON.stringify(summary(book)));
        if (batch.length === 25) {
          await out.write(batch.join("\n") + "\n");
          batch.length = 0;
        }
      }
      if (batch.length > 0) await out.write(batch.join("\n") + "\n");
    });
  });

  routes.get("/:id", zValidator("param", idParamSchema, rejectInvalid), async (c) => {
    const { id } = c.req.valid("param");
    const book = await service.getBook(id);
    c.header("ETag", entityTag(book.id, book.version));
    return c.json(service.view(book));
  });

  routes.post(
    "/",
    requireScope("catalogue:write"),
    zValidator("json", bookDraftSchema, rejectInvalid),
    async (c) => {
      const book = await service.createBook(c.req.valid("json"));
      c.header("Location", `/v1/books/${book.id}`);
      c.header("ETag", entityTag(book.id, book.version));
      return c.json(service.view(book), 201);
    },
  );

  routes.put(
    "/:id",
    requireScope("catalogue:write"),
    zValidator("param", idParamSchema, rejectInvalid),
    zValidator("json", bookDraftSchema, rejectInvalid),
    async (c) => {
      const { id } = c.req.valid("param");
      const book = await service.updateBook(id, c.req.valid("json"), expectedVersion(c.req.header("if-match"), id));
      c.header("ETag", entityTag(book.id, book.version));
      return c.json(service.view(book));
    },
  );

  routes.patch(
    "/:id",
    requireScope("catalogue:write"),
    zValidator("param", idParamSchema, rejectInvalid),
    zValidator("json", bookPatchSchema, rejectInvalid),
    async (c) => {
      const { id } = c.req.valid("param");
      const book = await service.updateBook(id, c.req.valid("json"), expectedVersion(c.req.header("if-match"), id));
      c.header("ETag", entityTag(book.id, book.version));
      return c.json(service.view(book));
    },
  );

  routes.delete(
    "/:id",
    requireScope("catalogue:write"),
    zValidator("param", idParamSchema, rejectInvalid),
    async (c) => {
      await service.deleteBook(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  return routes;
}
