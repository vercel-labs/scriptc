import { permanentRedirect } from "next/navigation";

export default function LegacyNodeCompatibilityPage() {
  permanentRedirect("/compatibility");
}
