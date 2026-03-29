import type { Metadata } from "next";

const CORE = process.env.NEXT_PUBLIC_CORE_URL || "http://127.0.0.1:4000";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ storeId: string; appId: string }>;
}): Promise<Metadata> {
  const { storeId, appId } = await params;
  try {
    const res = await fetch(`${CORE}/api/apps/${storeId}/${appId}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return { title: appId };
    const app = (await res.json()) as { name?: string; tagline?: string };
    return {
      title: app.name || appId,
      description: app.tagline || undefined,
    };
  } catch {
    return { title: appId };
  }
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
