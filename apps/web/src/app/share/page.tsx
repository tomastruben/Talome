import type { Metadata } from "next";
import { CapsulePreview } from "./capsule-preview";

export const metadata: Metadata = {
  title: "Shared Talome stack",
  description: "Preview a portable Talome app stack without connecting to the sender's server.",
  robots: { index: false, follow: false },
};

export default function SharedStackPage() {
  return <CapsulePreview />;
}
