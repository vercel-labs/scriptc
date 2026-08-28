// @dynamic
// Redirect URL resolution must remain byte-identical in the island-backed
// transport: fragments preserve the current resource, while backslashes in
// special URLs behave as forward slashes.
async function main(baseUrl: string, redirectKey: string): Promise<void> {
  const fragment = await fetch(`${baseUrl}/redirect-fragment/path`, {
    headers: { "x-redirect-key": redirectKey },
  });
  const fragmentBody: string = await fragment.text();
  console.log(
    "fragment:",
    `${fragment.status}`,
    `${fragment.url.endsWith("/redirect-fragment/path")}`,
    fragmentBody,
  );

  const backslash = await fetch(`${baseUrl}/redirect-backslash`);
  const backslashBody: string = await backslash.text();
  console.log(
    "backslash:",
    `${backslash.status}`,
    `${backslash.url.endsWith("/text")}`,
    backslashBody,
  );

  const sameScheme = await fetch(
    `${baseUrl}/redirect-same-scheme/dir/start`,
  );
  const sameSchemeBody: string = await sameScheme.text();
  console.log(
    "same scheme:",
    `${sameScheme.status}`,
    `${sameScheme.url.endsWith("/redirect-same-scheme/dir/next")}`,
    sameSchemeBody,
  );

  const invalidUtf8 = await fetch(`${baseUrl}/redirect-invalid-utf8`);
  const invalidUtf8Body: string = await invalidUtf8.text();
  console.log(
    "invalid utf8:",
    `${invalidUtf8.url.endsWith("/caf%EF%BF%BD")}`,
    invalidUtf8Body,
  );

  try {
    await fetch(`${baseUrl}/redirect-credentials`);
    console.log("credential redirect: resolved");
  } catch {
    console.log("credential redirect: rejected");
  }
}

main(process.argv[2], process.argv[4]);
