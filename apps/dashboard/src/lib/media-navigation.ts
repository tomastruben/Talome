export interface ContinueWatchingRouteItem {
  title?: string;
  type: "movie" | "tv";
  year?: number;
}

export interface MediaLibraryRouteItem {
  id: number;
  title: string;
  type: "movie" | "tv";
  year?: number;
}

function canonicalMediaTitle(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function withoutTrailingYear(title: string) {
  return title.replace(/\s+(?:19|20)\d{2}$/, "").trim();
}

export function resolveContinueWatchingRoute(
  item: ContinueWatchingRouteItem,
  libraryItems: MediaLibraryRouteItem[],
): string | null {
  const title = item.title?.trim();
  if (!title) return null;

  const canonicalTitle = canonicalMediaTitle(title);
  const titleWithoutYear = withoutTrailingYear(canonicalTitle);
  const candidates = libraryItems
    .filter((candidate) => candidate.type === item.type)
    .map((candidate) => {
      const candidateTitle = canonicalMediaTitle(candidate.title);
      const titlesMatch = candidateTitle === canonicalTitle;
      const titlesMatchWithoutYear = withoutTrailingYear(candidateTitle) === titleWithoutYear;
      if (!titlesMatch && !titlesMatchWithoutYear) return null;

      const yearScore = item.year && candidate.year
        ? item.year === candidate.year ? 2 : -1
        : 0;
      return {
        candidate,
        score: (titlesMatch ? 4 : 2) + yearScore,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const match = candidates[0]?.candidate;
  return match ? `/dashboard/media/${match.type}/${match.id}` : null;
}

export function continueWatchingFallbackRoute(item: ContinueWatchingRouteItem) {
  const params = new URLSearchParams({
    tab: item.type === "movie" ? "movies" : "tv",
  });
  if (item.title?.trim()) params.set("search", item.title.trim());
  return `/dashboard/media?${params.toString()}`;
}
