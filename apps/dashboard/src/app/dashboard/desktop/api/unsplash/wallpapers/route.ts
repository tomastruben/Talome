import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UNSPLASH_API_URL = "https://api.unsplash.com";
const WALLHAVEN_API_URL = "https://wallhaven.cc/api/v1";
const DEFAULT_QUERY = "nature wallpaper";
const RESULTS_PER_PAGE = 12;

interface UnsplashPhotoResponse {
  id: string;
  alt_description?: string | null;
  description?: string | null;
  color?: string | null;
  width: number;
  height: number;
  urls: {
    raw: string;
    small: string;
  };
  links: {
    html: string;
    download_location: string;
  };
  user: {
    name: string;
    username: string;
    links: {
      html: string;
    };
  };
}

interface UnsplashSearchResponse {
  total: number;
  total_pages: number;
  results: UnsplashPhotoResponse[];
  errors?: string[];
}

interface WallhavenWallpaperResponse {
  id: string;
  url: string;
  path: string;
  dimension_x: number;
  dimension_y: number;
  colors?: string[];
  thumbs: {
    large: string;
  };
  uploader?: {
    username: string;
  } | null;
}

interface WallhavenSearchResponse {
  data: WallhavenWallpaperResponse[];
  meta?: {
    current_page: number;
    last_page: number;
    total: number;
  };
}

function unsplashHeaders(accessKey: string): HeadersInit {
  return {
    Accept: "application/json",
    "Accept-Version": "v1",
    Authorization: `Client-ID ${accessKey}`,
  };
}

function withReferral(url: string): string {
  const referralUrl = new URL(url);
  referralUrl.searchParams.set("utm_source", "talome");
  referralUrl.searchParams.set("utm_medium", "referral");
  return referralUrl.toString();
}

function wallpaperUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("auto", "format");
  url.searchParams.set("fit", "crop");
  url.searchParams.set("w", "2560");
  url.searchParams.set("q", "85");
  return url.toString();
}

function wallhavenQuery(query: string): string {
  const withoutWallpaper = query.replace(/\bwallpapers?\b/gi, "").trim();
  return withoutWallpaper || "nature";
}

async function searchWallhaven(query: string, page: number) {
  const endpoint = new URL(`${WALLHAVEN_API_URL}/search`);
  endpoint.searchParams.set("q", wallhavenQuery(query));
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("categories", "100");
  endpoint.searchParams.set("purity", "100");
  endpoint.searchParams.set("sorting", "relevance");
  endpoint.searchParams.set("atleast", "1920x1080");
  endpoint.searchParams.set("ratios", "16x9,16x10,21x9");

  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    next: { revalidate: 300 },
  });
  const payload = await response.json() as WallhavenSearchResponse;
  if (!response.ok) {
    return NextResponse.json(
      { error: "Online wallpapers could not be loaded." },
      { status: response.status },
    );
  }

  const photos = payload.data.slice(0, RESULTS_PER_PAGE).map((photo) => {
    const contributor = photo.uploader?.username ?? "Wallhaven contributor";
    return {
      id: `wallhaven-${photo.id}`,
      description: `${wallhavenQuery(query)} wallpaper`,
      color: photo.colors?.[0] ?? "#18181b",
      width: photo.dimension_x,
      height: photo.dimension_y,
      thumbnailUrl: photo.thumbs.large,
      wallpaperUrl: photo.path,
      photoUrl: photo.url,
      photographer: {
        name: contributor,
        username: photo.uploader?.username ?? photo.id,
        profileUrl: photo.uploader
          ? `https://wallhaven.cc/user/${encodeURIComponent(photo.uploader.username)}`
          : photo.url,
      },
      provider: {
        name: "Wallhaven",
        url: photo.url,
      },
    };
  });

  return NextResponse.json({
    configured: false,
    provider: "wallhaven",
    query,
    page,
    total: payload.meta?.total ?? photos.length,
    totalPages: payload.meta?.last_page ?? 1,
    photos,
  });
}

export async function GET(request: NextRequest) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  const query = (request.nextUrl.searchParams.get("query") ?? DEFAULT_QUERY)
    .trim()
    .slice(0, 80) || DEFAULT_QUERY;
  const requestedPage = Number.parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage)
    ? Math.min(20, Math.max(1, requestedPage))
    : 1;

  if (!accessKey) {
    try {
      return await searchWallhaven(query, page);
    } catch {
      return NextResponse.json(
        { error: "Online wallpapers are temporarily unavailable." },
        { status: 502 },
      );
    }
  }

  const endpoint = new URL(`${UNSPLASH_API_URL}/search/photos`);
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("per_page", String(RESULTS_PER_PAGE));
  endpoint.searchParams.set("orientation", "landscape");
  endpoint.searchParams.set("content_filter", "high");

  try {
    const response = await fetch(endpoint, {
      headers: unsplashHeaders(accessKey),
      cache: "no-store",
    });
    const payload = await response.json() as UnsplashSearchResponse;
    if (!response.ok) {
      return NextResponse.json(
        {
          configured: true,
          error: payload.errors?.[0] ?? "Unsplash could not load wallpapers.",
        },
        { status: response.status },
      );
    }

    return NextResponse.json({
      configured: true,
      provider: "unsplash",
      query,
      page,
      total: payload.total,
      totalPages: payload.total_pages,
      photos: payload.results.map((photo) => ({
        id: photo.id,
        description: photo.alt_description ?? photo.description ?? "Unsplash wallpaper",
        color: photo.color ?? "#18181b",
        width: photo.width,
        height: photo.height,
        thumbnailUrl: photo.urls.small,
        wallpaperUrl: wallpaperUrl(photo.urls.raw),
        photoUrl: withReferral(photo.links.html),
        downloadLocation: photo.links.download_location,
        photographer: {
          name: photo.user.name,
          username: photo.user.username,
          profileUrl: withReferral(photo.user.links.html),
        },
        provider: {
          name: "Unsplash",
          url: withReferral(photo.links.html),
        },
      })),
    });
  } catch {
    return NextResponse.json(
      { configured: true, error: "Unsplash is temporarily unavailable." },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    return NextResponse.json(
      { error: "Unsplash download tracking is unavailable." },
      { status: 503 },
    );
  }

  let downloadLocation: string;
  try {
    const body = await request.json() as { downloadLocation?: unknown };
    downloadLocation = typeof body.downloadLocation === "string"
      ? body.downloadLocation
      : "";
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const endpoint = new URL(downloadLocation);
    const validEndpoint = endpoint.protocol === "https:"
      && endpoint.hostname === "api.unsplash.com"
      && /^\/photos\/[^/]+\/download$/.test(endpoint.pathname);
    if (!validEndpoint) {
      return NextResponse.json({ error: "Invalid Unsplash download location." }, { status: 400 });
    }

    const response = await fetch(endpoint, {
      headers: unsplashHeaders(accessKey),
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: "Unsplash could not register this wallpaper." },
        { status: response.status },
      );
    }
    return NextResponse.json({ tracked: true });
  } catch {
    return NextResponse.json({ error: "Invalid Unsplash download location." }, { status: 400 });
  }
}
