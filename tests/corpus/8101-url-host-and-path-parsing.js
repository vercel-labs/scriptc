// WHATWG URL host and path parsing: special hosts are percent-decoded and
// checked for forbidden domain code points (and read as IPv4 when they end
// in a number), opaque hosts and paths percent-encode the C0 control set,
// file: URLs take no port or credentials, empty hosts refuse credentials and
// ports, and host-less paths that start with "//" round-trip. Cases from the
// WPT url test data.
const parses = [
  ["file://example:1/", null],
  ["non-special:opaque  ?hi", null],
  ["non-special:opaque  #hi", null],
  ["non-special:opaque \t\t  \t#hi", null],
  ["non-special:opaque \t\t  #hi", null],
  ["non-special:opaque\t\t  \r #hi", null],
  ["sc://faß.ExAmPlE/", null],
  ["http://%30%78%63%30%2e%30%32%35%30.01", "http://other.com/"],
  ["http://%30%78%63%30%2e%30%32%35%30.01%2e", "http://other.com/"],
  ["sc://ñ.test/", null],
  ["sc://%/", null],
  ["sc://@/", null],
  ["sc://te@s:t@/", null],
  ["sc://:/", null],
  ["sc://:12/", null],
  ["x", "sc://ñ"],
  ["wow:\uFFFF", null],
  ["http://a\u007Fb/", null],
  ["sc://\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\u000b\f\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f\u007F!\"$%&'()*+,-.;=_`{}~/", null],
  ["asdf://%43%7C/", null],
  ["C|", "file://host/dir/file"],
  ["C|", "file://host/D:/dir1/dir2/file"],
  ["C|#", "file://host/dir/file"],
  ["C|?", "file://host/dir/file"],
  ["C|/", "file://host/dir/file"],
  ["C|\n/", "file://host/dir/file"],
  ["C|\\", "file://host/dir/file"],
  ["C|/", "file://host/"],
  ["file:C:/", "file://host/"],
  ["sc://ñ", null],
  ["sc://ñ?x", null],
  ["sc://ñ#x", null],
  ["#x", "sc://ñ"],
  ["?x", "sc://ñ"],
  ["", "non-spec:/..//p"],
  ["path", "non-spec:/..//p"],
  ["../path", "non-spec:/.//p"],
  ["non-special://%E2%80%A0/", null],
  ["non-special://H%4fSt/path", null],
  ["non-special:cannot-be-a-base-url-\u0000\u0001\u001f\u001e~\u007F\u0080", null],
  ["foo://!\"$%&'()*+,-.;=_`{}~/", null],
  ["foo://host/ !\"$%&'()*+,-./:;<=>@[\\]^_`{|}~", null],
  ["wss://host/ !\"$%&'()*+,-./:;<=>@[\\]^_`{|}~", null],
  ["non-special:\u0000y", null],
  ["non-special:x/\u0000y", null],
  ["non-special:\uFFFFy", null],
  ["non-special:x/\uFFFFy", null],
  ["data://:443", null],
  ["javascript://:443", null],
  ["mailto://:443", null],
  ["intent://:443", null],
  ["urn://:443", null],
  ["turn://:443", null],
  ["stun://:443", null],
];
function describe(url) {
  return [url.href, url.protocol, url.username, url.password, url.host, url.hostname, url.port, url.pathname, url.search, url.hash].join(" | ");
}
for (const [input, base] of parses) {
  let line;
  try {
    line = describe(base === null ? new URL(input) : new URL(input, base));
  } catch (e) {
    line = `throws ${e.code}`;
  }
  console.log(JSON.stringify(input), JSON.stringify(base), "=>", line);
}

const writes = [
  ["host", "sc://x/", "ß"],
  ["host", "file://y/", "loc%41lhost"],
  ["hostname", "file://y/", "loc%41lhost"],
  ["pathname", "a:/", "\u0000\u0001\t\n\r\u001f !\"#$%&'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~\u007F\u0080\u0081Éé"],
  ["search", "data:space ?query", ""],
  ["search", "sc:space ?query", ""],
  ["search", "data:space  ?query#fragment", ""],
  ["search", "sc:space  ?query#fragment", ""],
  ["hash", "data:space                                                                                                                                  #fragment", ""],
  ["hash", "sc:space    #fragment", ""],
  ["hash", "data:space  ?query#fragment", ""],
  ["hash", "sc:space  ?query#fragment", ""],
];
for (const [name, href, value] of writes) {
  const url = new URL(href);
  if (name === "host") url.host = value;
  else if (name === "hostname") url.hostname = value;
  else if (name === "port") url.port = value;
  else if (name === "pathname") url.pathname = value;
  else if (name === "protocol") url.protocol = value;
  else if (name === "username") url.username = value;
  else if (name === "password") url.password = value;
  else if (name === "search") url.search = value;
  else if (name === "hash") url.hash = value;
  else if (name === "href") url.href = value;
  console.log(name, JSON.stringify(href), JSON.stringify(value), "=>", describe(url));
}
