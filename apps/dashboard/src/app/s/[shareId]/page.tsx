import type { Metadata } from "next";
import { cache } from "react";
import { PublicStackPreview } from "./public-stack-preview";

export interface PublicStackData {
  id: string;
  name: string;
  description: string;
  tagline: string;
  author: string;
  tags: string[];
  version: string;
  appCount: number;
  apps: Array<{
    appId: string;
    name: string;
    description?: string;
    requiredInputCount: number;
  }>;
  createdAt: string;
  expiresAt: string;
}

const CORE_BACKEND = process.env.CORE_BACKEND_URL || "http://127.0.0.1:4000";

const fetchSharedStack = cache(async (shareId: string): Promise<PublicStackData | null> => {
  try {
    const response = await fetch(
      `${CORE_BACKEND}/api/stacks/public/${encodeURIComponent(shareId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    return await response.json() as PublicStackData;
  } catch {
    return null;
  }
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  const stack = await fetchSharedStack(shareId);
  if (!stack) return { title: "Shared Talome stack" };
  const description = `${stack.tagline || stack.description} · ${stack.appCount} app${stack.appCount === 1 ? "" : "s"}`;
  return {
    title: `${stack.name} · Talome`,
    description,
    openGraph: {
      title: stack.name,
      description,
      type: "website",
      siteName: "Talome",
    },
  };
}

export default async function SharedStackPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  const stack = await fetchSharedStack(shareId);
  return <PublicStackPreview shareId={shareId} stack={stack} />;
}
