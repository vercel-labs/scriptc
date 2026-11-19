// A rejected URL still has its decoded credentials: the scheme check throws
// ERR_INVALID_PROTOCOL, and the decoded pair must be released (the sanitized
// lane is the leak check).
import * as http from "node:http";
import * as https from "node:https";

let rejected = 0;
for (let i = 0; i < 20; i++) {
  try {
    http.get("https://user:secret@127.0.0.1:1/");
  } catch (e) {
    rejected++;
    if (rejected === 1) console.log("http code", (e as NodeJS.ErrnoException).code);
  }
  try {
    https.get("http://user:secret@127.0.0.1:1/");
  } catch (e) {
    rejected++;
  }
}
console.log("rejected", rejected);
