import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}): Promise<Metadata> {
  const { type, id } = await params;
  const label = type === "movie" ? "Movie" : type === "series" ? "Series" : type;
  return {
    title: `${label} #${id}`,
    description: `${label} details`,
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
