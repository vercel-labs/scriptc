import { ogHomeTitle, siteName } from "@/lib/site";
import { renderLabsOg } from "./labs-og";

export async function GET() {
  return renderLabsOg({ product: siteName, title: ogHomeTitle });
}
