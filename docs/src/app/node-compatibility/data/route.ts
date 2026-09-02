export function GET(request: Request) {
  return Response.redirect(new URL("/compatibility/data", request.url), 308);
}
