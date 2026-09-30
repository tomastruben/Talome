export interface FileManagerRoot {
  id: string;
  path: string;
  label: string;
  kind: "talome-files" | "external";
  isEmpty?: boolean;
  hostMount?: string;
  hostLabel?: string;
}

interface VisibleFileRootsOptions {
  keepTalomeFallback?: boolean;
}

/**
 * Keep an empty Talome Files sandbox out of drive-oriented surfaces. The Files
 * picker retains it only when it is the sole available location, so uploads
 * never become unreachable on installations without an external drive.
 */
export function getVisibleFileRoots(
  roots: FileManagerRoot[],
  { keepTalomeFallback = false }: VisibleFileRootsOptions = {},
): FileManagerRoot[] {
  const visible = roots.filter((root) => root.kind !== "talome-files" || root.isEmpty !== true);
  return keepTalomeFallback && visible.length === 0 ? roots : visible;
}
