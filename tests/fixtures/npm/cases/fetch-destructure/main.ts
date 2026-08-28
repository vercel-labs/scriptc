// @dynamic
// The package aliases the global object, then reads fetch through object
// destructuring during module evaluation. The native island must install
// fetch before boot; WASI must reject the absent network capability before
// linking.
import kind from "fetch-destructure";

console.log(`${kind}`);
