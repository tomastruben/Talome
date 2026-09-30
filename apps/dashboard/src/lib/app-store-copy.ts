/**
 * Copy for deleting an app the person created (My Apps), written from what
 * core's deleteUserApp actually does:
 * - an installed app is uninstalled first: its containers stop and are
 *   removed (its data folder is kept, as with any uninstall);
 * - the app leaves My Apps (registry, catalog row and app spec);
 * - its source files are NOT deleted: they stay in ~/.talome/user-apps/apps/<id>.
 */
export interface DeleteCreatedAppCopy {
  title: string;
  consequence: string;
  recovery: string;
  confirmLabel: string;
  busyLabel: string;
  receipt: string;
}

export function deleteCreatedAppCopy(name: string, appId: string, installed: boolean): DeleteCreatedAppCopy {
  const sourceDir = `~/.talome/user-apps/apps/${appId}`;
  return {
    title: `Delete ${name}?`,
    consequence: installed
      ? `${name} is uninstalled (its containers stop and are removed) and removed from My Apps. Its data stays in ~/.talome/app-data/${appId}.`
      : `${name} is removed from My Apps.`,
    recovery: `Its source files stay in ${sourceDir}. Removing it from My Apps can't be undone.`,
    confirmLabel: `Delete ${name}`,
    busyLabel: installed ? `Uninstalling and deleting ${name}…` : `Deleting ${name}…`,
    receipt: installed ? `Uninstalled and deleted ${name}` : `Deleted ${name}`,
  };
}

/**
 * Empty-catalog copy for the App Store. `stores` is undefined while the list
 * of app sources is loading or failed to load: then it's unknown whether any
 * exist, so the copy stays neutral instead of claiming there are none.
 */
export function emptyCatalogCopy(stores: readonly unknown[] | undefined): { title: string; description: string; action: string } {
  if (stores && stores.length === 0) {
    return {
      title: "No app sources yet",
      description: "Add an app source to browse and install apps.",
      action: "Add an app source",
    };
  }
  if (stores) {
    return {
      title: "No apps listed yet",
      description: "Your app sources haven't listed any apps yet. Sync them to fetch their catalogs.",
      action: "Open app sources",
    };
  }
  return {
    title: "No apps listed yet",
    description: "Talome has no apps to show. Check your app sources and sync them to fetch their catalogs.",
    action: "Open app sources",
  };
}
