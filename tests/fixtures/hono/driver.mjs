// HTTP driver for the library service: walks every route over one
// keep-alive connection and prints a transcript of each exchange (status
// line, raw response headers in wire order, body). The transcript is
// identical for any conforming server, so it is compared byte for byte
// between the Node and native lanes. Only `Date` is dropped and
// `X-Response-Time` normalized, since they vary from run to run.
//
//   node driver.mjs <port>
import http from "node:http";

const port = Number(process.argv[2]);
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const LIBRARIAN = "Bearer librarian-token";
const DESK = "Bearer desk-token";
const ROOT = "Bearer root-token";

function send(method, path, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const h = { ...headers };
    if (payload !== undefined) {
      h["content-type"] ??= "application/json";
      h["content-length"] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ res, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function formatHeaders(res) {
  const lines = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i];
    let value = res.rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (lower === "date") continue;
    if (lower === "x-response-time") value = /^\d+\.\d{3}ms$/.test(value) ? "<ms>" : `MALFORMED(${value})`;
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

function print(label, { res, text }) {
  process.stdout.write(`### ${label}\nHTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\n${formatHeaders(res)}\n\n${text}\n\n`);
}

async function step(label, method, path, options) {
  const result = await send(method, path, options);
  print(`${label}: ${method} ${path}`, result);
  return result;
}

const json = (result) => JSON.parse(result.text);

// ---- basics --------------------------------------------------------------
await step("health", "GET", "/health");
await step("unknown route", "GET", "/v1/nothing-here");
await step("wrong method", "DELETE", "/health");

// ---- listing -------------------------------------------------------------
const first = await step("list default", "GET", "/v1/books");
const filtered = await step("list filtered", "GET", "/v1/books?genre=science&minYear=1950&sort=-rating&limit=5");
const author = json(first).items[0].author;
await step("list by author", "GET", `/v1/books?author=${encodeURIComponent(author.toUpperCase())}&sort=year&limit=4`);
await step("list by tag", "GET", "/v1/books?tag=classic&available=true&offset=2&limit=3");
await step("list search", "GET", "/v1/books?q=garden&sort=title&limit=6");
await step("list format pages", "GET", "/v1/books?format=ebook&genre=travel&sort=-pages&limit=3&offset=1");
await step("list empty page", "GET", "/v1/books?genre=poetry&offset=9999");
await step("list invalid query", "GET", "/v1/books?limit=500&sort=bogus&minRating=7&available=maybe");
await step("list not modified", "GET", "/v1/books?genre=science&minYear=1950&sort=-rating&limit=5", {
  headers: { "if-none-match": filtered.res.headers.etag },
});
await step("list reordered query is same resource", "GET", "/v1/books?limit=5&sort=-rating&minYear=1950&genre=science", {
  headers: { "if-none-match": filtered.res.headers.etag },
});

// ---- single resource -----------------------------------------------------
const one = await step("get book", "GET", "/v1/books/bk_00001");
await step("get book not modified", "GET", "/v1/books/bk_00001", { headers: { "if-none-match": one.res.headers.etag } });
await step("get book stale tag", "GET", "/v1/books/bk_00001", { headers: { "if-none-match": 'W/"bk_00001-v0"' } });
await step("get book any tag", "GET", "/v1/books/bk_00002", { headers: { "if-none-match": "*" } });
await step("get missing book", "GET", "/v1/books/bk_99999");
await step("get malformed id", "GET", "/v1/books/not-an-id");

// ---- auth ----------------------------------------------------------------
const draft = {
  isbn: "978-0-306-40615-7",
  title: "  A Field Guide to Quiet Places  ",
  author: "Mira Novak",
  genre: "travel",
  format: "hardcover",
  year: 2021,
  pages: 312,
  copies: 2,
  tags: ["guide", "maps", "guide"],
  rating: 4.5,
};
await step("create without token", "POST", "/v1/books", { body: draft });
await step("create with bad scheme", "POST", "/v1/books", { body: draft, headers: { authorization: "Basic Zm9vOmJhcg==" } });
await step("create with unknown token", "POST", "/v1/books", { body: draft, headers: { authorization: "Bearer nope" } });
await step("create without scope", "POST", "/v1/books", { body: draft, headers: { authorization: DESK } });

// ---- create / validate -----------------------------------------------------
const created = await step("create", "POST", "/v1/books", { body: draft, headers: { authorization: LIBRARIAN } });
const newId = json(created).id;
await step("create duplicate isbn", "POST", "/v1/books", { body: { ...draft, title: "Other" }, headers: { authorization: LIBRARIAN } });
await step("create invalid", "POST", "/v1/books", {
  headers: { authorization: LIBRARIAN },
  body: { isbn: "978-0-306-40615-8", title: "", genre: "cooking", year: 1200.5, pages: -3, tags: ["Bad Tag"], rating: 9, extra: true },
});
await step("create malformed json", "POST", "/v1/books", { headers: { authorization: LIBRARIAN }, raw: '{"title": "x",' });
await step("create defaults", "POST", "/v1/books", {
  headers: { authorization: LIBRARIAN },
  body: { isbn: "978-1-4028-9462-6", title: "Minimal", author: "Lars Byrne", genre: "poetry", year: 1999, pages: 80 },
});

// ---- update ----------------------------------------------------------------
const patched = await step("patch with if-match", "PATCH", `/v1/books/${newId}`, {
  headers: { authorization: LIBRARIAN, "if-match": created.res.headers.etag },
  body: { rating: 4.8, tags: ["maps", "memoir"] },
});
await step("patch stale if-match", "PATCH", `/v1/books/${newId}`, {
  headers: { authorization: LIBRARIAN, "if-match": created.res.headers.etag },
  body: { rating: 1 },
});
await step("patch no-op", "PATCH", `/v1/books/${newId}`, { headers: { authorization: LIBRARIAN }, body: { rating: 4.8 } });
await step("patch empty", "PATCH", `/v1/books/${newId}`, { headers: { authorization: LIBRARIAN }, body: {} });
await step("put replace", "PUT", `/v1/books/${newId}`, {
  headers: { authorization: LIBRARIAN, "if-match": patched.res.headers.etag },
  body: { ...draft, title: "A Field Guide to Loud Places", copies: 1, tags: [] },
});
await step("put missing", "PUT", "/v1/books/bk_99999", { headers: { authorization: LIBRARIAN }, body: draft });

// ---- CORS ------------------------------------------------------------------
await step("preflight allowed", "OPTIONS", "/v1/books", {
  headers: { origin: "https://desk.example.org", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
});
await step("preflight foreign origin", "OPTIONS", "/v1/books", {
  headers: { origin: "https://evil.example.com", "access-control-request-method": "DELETE" },
});
await step("simple cors get", "GET", "/v1/books/bk_00003", { headers: { origin: "https://catalogue.example.org" } });

// ---- members and loans -------------------------------------------------------
const member = await step("create member", "POST", "/v1/members", {
  headers: { authorization: LIBRARIAN },
  body: { name: " Noor Haddad ", email: "Noor.Haddad@Example.org" },
});
const memberId = json(member).id;
await step("create member duplicate", "POST", "/v1/members", {
  headers: { authorization: LIBRARIAN },
  body: { name: "Someone", email: "noor.haddad@example.org", tier: "premium" },
});
await step("create member invalid", "POST", "/v1/members", {
  headers: { authorization: LIBRARIAN },
  body: { name: "", email: "not-an-email", tier: "gold" },
});
await step("quote", "POST", "/v1/loans/quote", { body: { bookId: newId, memberId, days: 30 } });
await step("quote invalid", "POST", "/v1/loans/quote", { body: { bookId: "book-1", memberId, days: 0 } });
await step("quote missing member", "POST", "/v1/loans/quote", { body: { bookId: newId, memberId: "mb_99999" } });
const loan = await step("open loan", "POST", "/v1/loans", { headers: { authorization: DESK }, body: { bookId: newId, memberId, days: 14 } });
const loanId = json(loan).id;
await step("open loan no copies", "POST", "/v1/loans", { headers: { authorization: DESK }, body: { bookId: newId, memberId } });
await step("delete book with loan", "DELETE", `/v1/books/${newId}`, { headers: { authorization: LIBRARIAN } });
const extra = [];
const lendable = json(await send("GET", "/v1/books?available=true&genre=fiction&sort=title&limit=3")).items.map((b) => b.id);
for (const id of lendable) {
  extra.push(await step("open loan", "POST", "/v1/loans", { headers: { authorization: DESK }, body: { bookId: id, memberId, days: 7 } }));
}
await step("member detail", "GET", `/v1/members/${memberId}`);
await step("member active loans", "GET", `/v1/members/${memberId}/loans?state=active`);
await step("close loan", "POST", `/v1/loans/${loanId}/close`, { headers: { authorization: DESK }, body: {} });
await step("close loan again", "POST", `/v1/loans/${loanId}/close`, { headers: { authorization: DESK }, body: { outcome: "lost" } });
await step("report lost", "POST", `/v1/loans/${json(extra[0]).id}/close`, { headers: { authorization: DESK }, body: { outcome: "lost" } });
await step("get loan", "GET", `/v1/loans/${json(extra[0]).id}`);
await step("member all loans", "GET", `/v1/members/${memberId}/loans`);
await step("suspend without admin", "POST", `/v1/members/${memberId}/suspend`, { headers: { authorization: LIBRARIAN } });
await step("suspend", "POST", `/v1/members/${memberId}/suspend`, { headers: { authorization: ROOT } });
await step("loan while suspended", "POST", "/v1/loans", { headers: { authorization: DESK }, body: { bookId: "bk_00020", memberId } });
await step("reinstate", "POST", `/v1/members/${memberId}/reinstate`, { headers: { authorization: ROOT } });
await step("delete book", "DELETE", `/v1/books/${newId}`, { headers: { authorization: LIBRARIAN } });
await step("get deleted book", "GET", `/v1/books/${newId}`);

// ---- stats, export, feed -----------------------------------------------------
const stats = await step("stats", "GET", "/v1/stats");
await step("stats not modified", "GET", "/v1/stats", { headers: { "if-none-match": stats.res.headers.etag } });
await step("export poetry", "GET", "/v1/books/export?genre=poetry&sort=title");
await step("export invalid", "GET", "/v1/books/export?sort=sideways");
const health = json(await send("GET", "/health"));
void health;
const lastSeq = Number(/"lastSeq":(\d+)/.exec((await send("GET", "/v1/events?limit=1")).text)[1]);
await step("events replay", "GET", `/v1/events?after=${lastSeq - 4}&limit=4`);

// Follow the live feed: two events are already in history, the third is
// appended by a write issued once the stream is open.
await new Promise((resolve, reject) => {
  const liveAgent = new http.Agent({ keepAlive: false });
  const path = `/v1/events?after=${lastSeq - 2}&limit=3`;
  const req = http.request({ host: "127.0.0.1", port, method: "GET", path, agent: liveAgent }, (res) => {
    const chunks = [];
    let triggered = false;
    res.on("data", (c) => {
      chunks.push(c);
      if (!triggered && Buffer.concat(chunks).toString("utf8").includes(`id: ${lastSeq}\n`)) {
        triggered = true;
        send("POST", "/v1/members", { headers: { authorization: LIBRARIAN }, body: { name: "Live Reader", email: "live@example.org" } }).catch(reject);
      }
    });
    res.on("end", () => {
      print(`events live follow: GET ${path}`, { res, text: Buffer.concat(chunks).toString("utf8") });
      resolve();
    });
  });
  req.on("error", reject);
  req.end();
});
await step("events invalid", "GET", "/v1/events?limit=0");

// ---- shutdown ----------------------------------------------------------------
await step("shutdown wrong token", "POST", "/admin/shutdown", { headers: { authorization: "Bearer wrong" } });
await step("shutdown", "POST", "/admin/shutdown", { headers: { authorization: "Bearer shutdown-token" } });
agent.destroy();
