// net.isIP, isIPv4 and isIPv6 on non-string inputs and the text forms the
// address patterns reject: only a string is inspected (numbers, booleans,
// null, undefined, objects and arrays answer 0), IPv4 leading zeros and
// whitespace are invalid, an IPv6 zone may be empty or numeric, and the
// IPv4-in-IPv6 tails must fill the address exactly.
import * as net from "node:net";

const inputs: any[] = [
  42,
  0,
  1.5,
  NaN,
  true,
  false,
  null,
  undefined,
  {},
  " 1.2.3.4",
  "1.2.3.4 ",
  "1.2.3.4\n",
  "0.0.0.0",
  "00.0.0.0",
  "1.2.3.04",
  "::ffff:1.2.3.4",
  "::FFFF:0102:0304",
  "fe80::1%0",
  "fe80::1%-1",
  "%",
  "::%eth0",
  "1::%eth0",
  "0:0:0:0:0:0:0:1",
  ":::",
  "1:2:3:4:5:6:7",
  "1:2:3:4:5:6:7:8:",
  "1:2:3:4:5:6:7:8%",
  "::1.2.3.4",
  "::1.2.3",
  "1:2:3:4:5:6:1.2.3.4",
  "1:2:3:4:5:6:7:8.9.10.11",
  "1234:5678:9abc:def0:1234:5678:9abc:def0",
  "1234:5678:9abc:def0:1234:5678:9abc:def01",
  "::0:0:0:0:0:0:0",
];
for (const input of inputs) {
  console.log(String(input) + ":" + typeof input, net.isIP(input), net.isIPv4(input), net.isIPv6(input));
}
