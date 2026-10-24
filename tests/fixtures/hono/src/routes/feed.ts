/* The change feed (server-sent events) and the aggregate stats endpoint. */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { etag } from "hono/etag";
import { streamSSE } from "hono/streaming";
import { eventSubject } from "../domain.ts";
import { rejectInvalid, type AppEnv } from "../middleware.ts";
import { eventsQuerySchema } from "../schemas.ts";
import type { LibraryService } from "../service.ts";
import { computeStats } from "../stats.ts";

export function feedRoutes(service: LibraryService) {
  const routes = new Hono<AppEnv>();

  routes.get("/events", zValidator("query", eventsQuerySchema, rejectInvalid), (c) => {
    const { after, limit } = c.req.valid("query");
    c.header("Cache-Control", "no-store");
    return streamSSE(c, async (sse) => {
      await sse.writeSSE({ event: "hello", data: JSON.stringify({ lastSeq: service.events.lastSeq }) });
      for await (const entry of service.events.follow(after, limit)) {
        await sse.writeSSE({
          id: String(entry.seq),
          event: entry.event.type,
          data: JSON.stringify({ subject: eventSubject(entry.event), at: entry.event.at }),
        });
      }
      await sse.writeSSE({ event: "end", data: "{}" });
    });
  });

  // Stats are hashed by the etag middleware (SHA-1 of the body).
  routes.get("/stats", etag(), (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json(computeStats(service));
  });

  return routes;
}
