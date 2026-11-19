import undici from "undici";

const res = await undici.request(process.argv[2] + "/read");
console.log(res.statusCode, await res.body.text());
