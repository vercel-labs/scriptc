// A request that stops before it dials gives back the transport context it
// built: an https fetch with an invalid header value allocates the TLS
// context first and rejects at the value check, and the tunnel forms build
// theirs the same way. The sanitized lane's LeakSanitizer reports a context
// that is never returned.
function attempt(url: string): Promise<string> {
  return fetch(url, { headers: { "x-test": "a\u0001b" } }).then(
    () => "sent",
    (caught: any) => `${caught.constructor.name} ${JSON.stringify(caught.message)}`,
  );
}

const attempts: Promise<string>[] = [];
for (let i = 0; i < 4; i++) attempts.push(attempt("https://127.0.0.1:9/"));
attempts.push(attempt("http://127.0.0.1:9/"));
Promise.all(attempts).then((results) => {
  console.log(JSON.stringify(results));
});
