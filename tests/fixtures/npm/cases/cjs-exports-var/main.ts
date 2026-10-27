// A CommonJS module that names its export object through a variable
// (`var ip = exports; ip.isPrivate = function …`), the ip package's
// shape, imported by default as Node does: its members are the exports,
// including the ones it calls on itself through the alias.
import ip from "exportsvar";

for (const addr of ["10.0.0.1", "192.168.1.20", "127.0.0.1", "::1", "8.8.8.8"]) {
  console.log(addr, ip.isPrivate(addr), ip.isLoopback(addr), ip.isPublic(addr));
}
console.log(ip.toLong("192.168.1.1"));
// Members whose parameter shadows the alias name.
console.log(ip.isV4Format("1.2.3.4"), ip.isV4Format("::1"), ip.normalize("  FE80::1 "));
// Members with a block-local `let` or a loop `const` of the alias name:
// only that block or loop names the local binding.
console.log(ip.classify("FE80::1"), ip.classify("10.1.2.3"), ip.classify("8.8.4.4"));
console.log(ip.countPrivate(["127.0.0.1", "10.0.0.2", "10.9.9.9"]), ip.countPrivate(["10.0.0.1"]));
