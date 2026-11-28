// One long inherited charset beside many short same-essence entries: the
// chosen value inherits the essence's charset once, so the parse costs its
// own input rather than one charset copy per entry.
const body = () => new Uint8Array([104, 105]);
const charset = "a".repeat(1 << 19);
const entries = Array.from({ length: 50000 }, () => "text/plain").join(", ");
const blob = await new Response(body(), {
  headers: { "content-type": `text/plain; charset=${charset}, ${entries}` },
}).blob();
const type = blob.type;
const occurrences = type.split("charset=").length - 1;
console.log(
  `many ${type.length} ${type.startsWith("text/plain;charset=" + charset)} ${occurrences} ${blob.size}`,
);
