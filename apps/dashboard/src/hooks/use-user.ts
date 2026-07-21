import useSWR from "swr";
import type { UserPermissions, FeaturePermission } from "@talome/types";

export interface UserWallpaperAttribution {
  photoUrl: string;
  photographerName: string;
  photographerUrl: string;
  providerName?: string;
}

export interface UserPreferences {
  desktopMode?: "classic" | "desktop";
  desktopWallpaper?: {
    wallpaperUrl: string | null;
    attribution: UserWallpaperAttribution | null;
  };
}

interface UserInfo {
  authenticated: boolean;
  userId?: string;
  username?: string;
  email?: string;
  role?: "admin" | "member";
  permissions?: UserPermissions;
  preferences?: UserPreferences;
}

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

export function useUser() {
  const { data, error, isLoading, mutate } = useSWR<UserInfo>("/api/auth/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });

  const isAdmin = data?.role === "admin";

  function hasPermission(feature: FeaturePermission): boolean {
    if (isAdmin) return true;
    if (!data?.permissions) return true;
    return data.permissions[feature] !== false;
  }

  return {
    user: data,
    isAdmin,
    isLoading,
    error,
    mutate,
    hasPermission,
  };
}
