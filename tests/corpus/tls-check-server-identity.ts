// tls.checkServerIdentity: Node's standalone hostname verification over a
// legacy certificate object — SAN DNS names with RFC 6125 wildcards, IP
// SANs compared canonicalized, the CN fallback only without DNS SANs, and
// the escaped alt-name string form.
import * as tls from "node:tls";

const show = (label: string, err: Error | undefined): void => {
  if (err === undefined) {
    console.log(label, "match");
    return;
  }
  const coded = err as NodeJS.ErrnoException;
  const extra = err as any;
  console.log(label, coded.code, "|", err.message, "|", extra.host, "|", typeof extra.cert);
};

show("dns", tls.checkServerIdentity("localhost", { subjectaltname: "DNS:localhost" }));
show("dns-miss", tls.checkServerIdentity("b", { subjectaltname: "DNS:a" }));
show("wildcard", tls.checkServerIdentity("a.example.com", { subjectaltname: "DNS:*.example.com" }));
show(
  "wildcard-deep",
  tls.checkServerIdentity("b.a.example.com", { subjectaltname: "DNS:*.example.com" }),
);
show("wildcard-apex", tls.checkServerIdentity("example.com", { subjectaltname: "DNS:*.example.com" }));
show("ip", tls.checkServerIdentity("127.0.0.1", { subjectaltname: "IP Address:127.0.0.1" }));
show("ip-miss", tls.checkServerIdentity("1.2.3.4", { subjectaltname: "IP Address:5.6.7.8, IP Address:::1" }));
show("ip6", tls.checkServerIdentity("::1", { subjectaltname: "IP Address:0:0:0:0:0:0:0:1" }));
show("cn", tls.checkServerIdentity("cn.example", { subject: { CN: "cn.example" } }));
show("cn-miss", tls.checkServerIdentity("nomatch", { subject: { CN: "other" } }));
show("no-names", tls.checkServerIdentity("nomatch", { subject: {} }));
show(
  "trailing-dot",
  tls.checkServerIdentity("a.example.com.", { subjectaltname: "DNS:*.example.com" }),
);
show(
  "quoted",
  tls.checkServerIdentity("a,b.example.com", { subjectaltname: 'DNS:"a,b.example.com"' }),
);
show("upper", tls.checkServerIdentity("A.Example.COM", { subjectaltname: "DNS:a.example.com" }));
try {
  tls.checkServerIdentity("a", { subjectaltname: 'DNS:"unterminated' });
} catch (err) {
  const coded = err as NodeJS.ErrnoException;
  console.log("format", coded.code, "|", (err as Error).message);
}
