// HTTPS ServerOptions extends the HTTP option surface: literal and bound
// option records initialize keepAliveTimeoutBuffer with the same validation
// as http.createServer. No listen is needed to observe the server property.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const literal = createServer({ cert, key, keepAliveTimeoutBuffer: 4321 }, () => {});
console.log("literal", literal.keepAliveTimeoutBuffer);

const options = { cert, key, keepAliveTimeoutBuffer: 5432 };
const bound = createServer(options, () => {});
console.log("bound", bound.keepAliveTimeoutBuffer);

try {
  createServer({ cert, key, keepAliveTimeoutBuffer: -1 }, () => {});
} catch (err) {
  if (err instanceof Error) {
    console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
  }
}
