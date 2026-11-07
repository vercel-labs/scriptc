/* Entry point: seeds the library, listens on PORT (0 picks a free port)
 * and reports the bound port on stderr as `PORT <n>`. POST /admin/shutdown
 * with the admin token stops the server. */

import { serve } from "@hono/node-server";
import { createApp } from "./src/app.ts";
import { SteppingClock } from "./src/clock.ts";
import { TokenRegistry } from "./src/middleware.ts";
import { seed } from "./src/seed.ts";

const tokens = new TokenRegistry()
  .register("librarian-token", "librarian", ["catalogue:write", "members:write", "loans:write"])
  .register("desk-token", "front-desk", ["loans:write"])
  .register("root-token", "root", ["admin"]);

const { app, service, requests } = createApp({
  clock: new SteppingClock(Date.UTC(2024, 5, 1, 9, 0, 0), 1000),
  tokens,
  adminToken: "shutdown-token",
  allowedOrigins: ["https://catalogue.example.org", "https://desk.example.org"],
  onShutdown: () => {
    server.close(() => {
      console.log(`stopped after ${requests()} requests`);
    });
    if ("closeAllConnections" in server) server.closeAllConnections();
  },
});

const size = process.env["LIBRARY_SIZE"] === "large" ? { books: 5000, members: 400, loans: 2000 } : { books: 400, members: 60, loans: 180 };
await seed(service, size);
console.log(`library ready: ${service.books.size} books, ${service.members.size} members, ${service.loans.size} loans`);

const server = serve({ fetch: app.fetch, port: Number(process.env["PORT"] ?? 0), hostname: "127.0.0.1" }, (info) => {
  process.stderr.write(`PORT ${info.port}\n`);
});
