// A record converted to a narrower record type the program can observe
// keeps the original object: the narrower name is a view of it, so identity
// comparisons agree and writes through either name reach the same fields,
// as in Node. Differentially vs Node.
interface Endpoint {
  sessionId: string;
  token: string;
}
interface Connection extends Endpoint {
  expiresAt: number;
  policy: string;
}

const connection: Connection = {
  sessionId: "s-1",
  token: "t-1",
  expiresAt: 1_700_000_000,
  policy: "fast",
};

// A local binding: identity and writes in both directions.
const endpoint: Endpoint = connection;
console.log("local identity", (endpoint as unknown) === (connection as unknown));
endpoint.sessionId = "by-view";
console.log("local write view->wide", connection.sessionId);
connection.token = "by-wide";
console.log("local write wide->view", endpoint.token);

// A class field: the stored value is the same object.
class Registry {
  current: Endpoint | null = null;
  misses = 0;
  remember(value: Endpoint): void {
    if (this.current !== value) {
      this.current = value;
      this.misses += 1;
    }
  }
}
const registry = new Registry();
registry.remember(endpoint);
registry.remember(endpoint);
registry.remember(connection);
console.log("field identity", registry.misses);
if (registry.current !== null) {
  registry.current.token = "by-field";
}
console.log("field write", connection.token);

// A call argument and a return value.
function narrow(value: Connection): Endpoint {
  return value;
}
const returned = narrow(connection);
console.log("return identity", (returned as unknown) === (connection as unknown));
function touch(value: Endpoint): void {
  value.sessionId = "by-argument";
}
touch(connection);
console.log("argument write", endpoint.sessionId);

// A chain of bindings keeps the one object.
const again: Endpoint = connection;
const twice: Endpoint = again;
console.log("chain identity", (twice as unknown) === (connection as unknown));

// An unobserved narrowing is still a copy: fresh values answer the same
// fields either way.
function fresh(): Connection {
  return { sessionId: "f", token: "f", expiresAt: 2, policy: "slow" };
}
const unnamed: Endpoint = fresh();
console.log("fresh", unnamed.sessionId, unnamed.token);
