// `instanceof` alone must select the WebSocket runtime unit (the tag test
// lives there), so a program that never constructs a socket still links.
console.log({} instanceof WebSocket, undefined instanceof WebSocket, "x" instanceof WebSocket);
