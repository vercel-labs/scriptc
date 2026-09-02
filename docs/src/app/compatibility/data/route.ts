import snapshot from "@/generated/node-v24-compatibility.json";

export const dynamic = "force-static";
export const revalidate = false;

export function GET() {
  return Response.json(snapshot, {
    headers: {
      // The client adds a generated content hash to the URL. Keep dev
      // uncached; production can cache each immutable artifact URL.
      "Cache-Control": process.env.NODE_ENV === "production" ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}
