// An unparsable proxy value: Node throws ERR_PROXY_INVALID_CONFIG from the
// request constructor, with the offending value as the message.
import * as http from "node:http";
import * as https from "node:https";

const report = (label: string, run: () => void): void => {
  try {
    run();
    console.log(label, "no throw");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "threw", err.code);
    console.log(label, "message", JSON.stringify(err.message));
  }
};

report("http", () => {
  http.setGlobalProxyFromEnv({ http_proxy: " not-a-url " });
  http.get("http://target.invalid/x").on("error", () => {});
});
report("https", () => {
  http.setGlobalProxyFromEnv({ https_proxy: "junk" });
  https.get("https://target.invalid/x").on("error", () => {});
});
