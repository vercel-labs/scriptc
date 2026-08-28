process.env.NODE_USE_ENV_PROXY = "1";
process.env.http_proxy = process.argv[3] as string;
process.env.HTTP_PROXY = process.argv[3] as string;
process.env.NODE_EXTRA_CA_CERTS = process.argv[5] as string;

const direct = await fetch(process.argv[2] as string);
console.log(`http: ${await direct.text()}`);

try {
  const secure = await fetch(process.argv[4] as string);
  console.log(`https: ${await secure.text()}`);
} catch {
  console.log("https: rejected");
}
