// @dynamic
// @npm-static
// T3 L6 integration smoke — the ai-core server shape: an express app, zod
// validation, and a pg client in one program under --npm-static auto.
// express's own lib requires qs and send, packages nothing in this file
// imports directly, so the flagless build only succeeds when auto's
// transitive closure opts the pair in. zod joins statically; pg ships a
// minified dist, misses the eligibility bar, and serves from the island
// with the coverage note — the differential stays byte-exact either way.
import express from "express";
import { z } from "zod";
import pg from "pg";

const app = express();
app.get("/greet", () => "hello");
app.get("/bye", () => "goodbye");
console.log(app.handle("/greet?name=ada"));
console.log(app.handle("/bye?name=grace"));
console.log(app.handle("/missing"));
console.log(app.resolve("/tmp/report.json"));

const shape = z.object(["name:string", "age:number"]);
const row = shape.parse(["ada", "36"]);
console.log(row.join(","));

const client = pg.createClient({ host: "localhost", port: 5432, database: "ai" });
const found = client.query({ text: "select $1, $2", values: ["a", "b"] });
console.log(found.text, found.values.join(","));
