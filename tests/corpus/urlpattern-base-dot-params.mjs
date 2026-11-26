// A ".." segment in a base-resolved pathname ascends over literal segments
// only: a segment carrying pattern syntax stays, and the ".." itself is
// dropped, so a parameter is never removed from the pattern by resolution.
function show(label, init, urls) {
  try {
    const p = new URLPattern(init);
    console.log(label, JSON.stringify(p.pathname), urls.map((u) => p.test("https://h" + u)));
  } catch (e) {
    console.log(label, "threw", e.name, e.message);
  }
}
const base = "https://h/root/";
show("param", { pathname: "a/:x/../b", baseURL: base }, ["/root/a/7/b", "/root/a/b", "/root/b"]);
show("param end", { pathname: "a/:x/..", baseURL: base }, ["/root/a/7/", "/root/a/7", "/root/a/"]);
show("wildcard", { pathname: "a/*/../b", baseURL: base }, ["/root/a/q/b", "/root/a/b"]);
show("two dots", { pathname: "a/:x/../../b", baseURL: base }, ["/root/a/7/b", "/root/b"]);
show("literal", { pathname: "a/../b", baseURL: base }, ["/root/b", "/root/a/b"]);
show("absolute", { pathname: "/a/:x/../b", baseURL: base }, ["/a/7/b", "/a/b"]);
