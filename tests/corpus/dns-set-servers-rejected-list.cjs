// dns.setServers validates every entry before it touches the resolver, and a
// rejected configuration keeps none of the prefix it had parsed. The message
// names the first bad entry, the resolver keeps its previous servers, and
// repeated rejections are answered the same way. The module setter shares its
// parser with the Resolver and dns/promises setters.
const dns = require("node:dns");
/** @type {any} */
const bad = 5;

function attempt(label, run) {
  try {
    run();
    console.log(label, "accepted");
  } catch (e) {
    console.log(label, e.code, e.message);
  }
}

let before = dns.getServers().join(",");
const list = ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5", bad];
for (let i = 0; i < 20; i++) {
  attempt("set", () => dns.setServers(list));
}
console.log("kept", dns.getServers().join(",") === before);
