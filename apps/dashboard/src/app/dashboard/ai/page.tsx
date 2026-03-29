"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LocalAIRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/dashboard/settings/ai-provider"); }, [router]);
  return null;
}
