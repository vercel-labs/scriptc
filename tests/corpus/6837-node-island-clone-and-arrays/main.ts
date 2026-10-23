// @requires-libnode
// structuredClone in a Node island of native objects passed in clones
// their data, as under Node; arrays of plain values the island returns,
// directly or through a promise, arrive as arrays.
import { cloneClaims, cloneFails, cloneNested, listFiles, matrix, names } from "data-pkg";

interface Claims {
  sub: string;
  aud: string;
  exp: number;
}

class Session {
  user = "ada";
  level = 2;
}

async function main(): Promise<void> {
  const claims: Claims = { sub: "user-1", aud: "api", exp: 1700000000 };
  console.log(cloneClaims(claims));
  console.log("native unchanged", claims.sub);
  console.log(cloneNested({ list: [1, 2], session: new Session() }));
  console.log(cloneNested([claims, claims]));
  const tags: string[] = ["a", "b"];
  console.log(cloneNested({ tags, claims }), cloneNested(tags));
  console.log(cloneFails());
  const files = await listFiles("/tmp");
  for (const f of files) console.log("file", f);
  console.log("count", files.length, files.join(","));
  console.log("names", names().join("|"), names().length);
  const m = await matrix();
  console.log("matrix", m.length, m[0].join("+"), m[1][0]);
}

main();
