// A declaration file types a JavaScript class's inherited setters as
// returning `this` (jose's SignJWT over JWTClaimsBuilder): chained calls
// on the subclass keep the subclass, so its own methods stay callable.
import { Counter, Signer } from "fluent";

console.log(new Signer({ role: "admin" }).setHeader("HS256").setSubject("alice").setIssuer("me").sign());
console.log(new Signer().setSubject("bob").setHeader("HS384").sign());
const signer = new Signer({ n: 1 }).setIssuer("you").setSubject("carol");
console.log(signer.setHeader("HS512").sign());
const counter = new Counter({ a: 1 }).setSubject("dave").setIssuer("eve");
console.log(counter.count(), counter.setHeader("x").sign(), counter instanceof Counter);
function described(s: Signer): string {
  return s.setSubject("frank").sign();
}
console.log(described(new Counter().setHeader("y")));
const reset = new Counter({ b: 2 }).reset();
console.log(reset.count(), reset.setSubject("gina").count());
