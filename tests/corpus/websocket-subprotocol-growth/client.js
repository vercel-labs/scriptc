// The offered subprotocols as a dynamic array: the second element's ToString
// grows the array, so the constructor must read the elements before it runs.
export function connect(url) {
  const protocols = ["first"];
  const tricky = {
    toString() {
      protocols.push("later");
      return "second";
    },
  };
  return { ws: new WebSocket(url, [protocols[0], tricky]), protocols };
}
