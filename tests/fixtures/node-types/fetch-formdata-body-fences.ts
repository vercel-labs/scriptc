/* A FormData request body typechecks under @types/node's BodyInit, but Node
 * sends it as a multipart encoding, which the native fetch does not
 * implement; the USVString fallback would send "[object FormData]" under
 * text/plain instead. The build must refuse each form by name. Blob and File
 * bodies send their bytes, so they compile. */
declare const form: FormData;

void fetch("https://example.invalid/", { method: "POST", body: form });
const init: RequestInit = { body: form };
void fetch("https://example.invalid/", init);
void new Request("https://example.invalid/", { method: "POST", body: form });
