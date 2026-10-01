/** Source names as people know them ("casaos" reads "CasaOS"). */
export function sourceLabel(type: string): string {
  if (type === "casaos") return "CasaOS";
  if (type === "umbrel") return "Umbrel";
  if (type === "user-created") return "My Apps";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Categories in sentence case ("media" reads "Media"); two-letter ones are acronyms ("ai" reads "AI"). */
export function categoryLabel(category: string): string {
  return category.length <= 2 ? category.toUpperCase() : category.charAt(0).toUpperCase() + category.slice(1);
}

/** What a wide window's toolbar calls the view its sidebar chose. */
export function appStoreViewTitle(tab: string): string {
  if (tab === "all") return "All apps";
  if (tab === "installed") return "Installed";
  return sourceLabel(tab);
}
