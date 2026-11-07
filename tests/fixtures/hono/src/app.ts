/* Assembles the application: middleware stack, route modules and the
 * service instance they share. */

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import type { Clock } from "./clock.ts";
import { authenticate, notFound, onError, requestId, responseTime, TokenRegistry, type AppEnv } from "./middleware.ts";
import { bookRoutes } from "./routes/books.ts";
import { feedRoutes } from "./routes/feed.ts";
import { loanRoutes, memberRoutes } from "./routes/members.ts";
import { LibraryService } from "./service.ts";

export interface AppOptions {
  readonly clock: Clock;
  readonly tokens: TokenRegistry;
  readonly adminToken: string;
  readonly allowedOrigins: readonly string[];
  readonly onShutdown: () => void;
}

export interface Application {
  readonly app: Hono<AppEnv>;
  readonly service: LibraryService;
  readonly requests: () => number;
}

export function createApp(options: AppOptions): Application {
  const service = new LibraryService(options.clock);
  const app = new Hono<AppEnv>();
  let served = 0;

  app.use("*", async (_c, next) => {
    served++;
    await next();
  });
  app.use("*", requestId());
  app.use("*", responseTime());
  app.use(
    "/v1/*",
    cors({
      origin: [...options.allowedOrigins],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowHeaders: ["Authorization", "Content-Type", "If-Match", "If-None-Match", "X-Request-Id"],
      exposeHeaders: ["ETag", "Location", "X-Response-Time", "X-Request-Id", "X-Total-Count"],
      maxAge: 600,
      credentials: true,
    }),
  );
  app.use("/v1/*", authenticate(options.tokens));

  app.get("/health", (c) => c.json({ status: "ok", books: service.books.size, members: service.members.size }));
  app.route("/v1/books", bookRoutes(service));
  app.route("/v1/members", memberRoutes(service));
  app.route("/v1/loans", loanRoutes(service));
  app.route("/v1", feedRoutes(service));

  app.post("/admin/shutdown", bearerAuth({ token: options.adminToken }), (c) => {
    setTimeout(options.onShutdown, 10);
    return c.json({ stopping: true, served });
  });

  app.onError(onError);
  app.notFound(notFound);
  return { app, service, requests: () => served };
}
