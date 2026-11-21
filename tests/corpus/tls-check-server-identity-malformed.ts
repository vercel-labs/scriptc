// tls.checkServerIdentity over malformed legacy SAN text: Node's splitter
// tolerates a trailing comma and a comma without its space, and embedded
// NULs never match (the SAN pattern, the CN, or the hostname).
import * as tls from "node:tls";

const show = (label: string, err: Error | undefined): void => {
  if (err === undefined) {
    console.log(label, "match");
    return;
  }
  const coded = err as NodeJS.ErrnoException;
  console.log(label, coded.code, "|", JSON.stringify((err as Error).message));
};

show("trailing-comma", tls.checkServerIdentity("a", { subjectaltname: 'DNS:"a",' }));
show("comma-no-space", tls.checkServerIdentity("a", { subjectaltname: 'DNS:"a",DNS:b' }));
show("nul-san", tls.checkServerIdentity("a", { subjectaltname: 'DNS:"a\\u0000evil"' }));
show("nul-cn", tls.checkServerIdentity("a", { subject: { CN: "a\u0000evil" } }));
show("nul-host", tls.checkServerIdentity("a\u0000evil", { subjectaltname: "DNS:a" }));
