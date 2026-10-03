"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HugeiconsIcon, Refresh04Icon, MoreHorizontalIcon, Delete02Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import type { StoreSource } from "@talome/types";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";

export function AppSourcesSection() {
  const [storeSources, setStoreSources] = useState<StoreSource[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [storeSyncErrors, setStoreSyncErrors] = useState<Record<string, string>>({});
  const [newStoreName, setNewStoreName] = useState("");
  const [newStoreUrl, setNewStoreUrl] = useState("");
  const [addingStore, setAddingStore] = useState(false);
  const [syncingStore, setSyncingStore] = useState<string | null>(null);

  const fetchStores = useCallback(async () => {
    setStoresLoading(true);
    setStoresError(null);
    try {
      const res = await fetch(`${CORE_URL}/api/stores`);
      if (!res.ok) throw new Error(`Failed to load app sources (${res.status})`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid app source response");
      setStoreSources(data as StoreSource[]);
    } catch {
      setStoresError("Could not load app sources. Talome Core may be offline.");
      setStoreSources([]);
    } finally {
      setStoresLoading(false);
    }
  }, []);

  useEffect(() => { fetchStores(); }, [fetchStores]);

  const handleAddStore = async () => {
    if (!newStoreName || !newStoreUrl) return;
    setAddingStore(true);
    try {
      const res = await fetch(`${CORE_URL}/api/stores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newStoreName, gitUrl: newStoreUrl }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success("Store added");
        setNewStoreName("");
        setNewStoreUrl("");
        fetchStores();
      } else {
        toast.error(data.error || "Failed to add store");
      }
    } catch {
      toast.error("Failed to add store");
    } finally {
      setAddingStore(false);
    }
  };

  const handleSyncStore = async (id: string) => {
    setSyncingStore(id);
    try {
      const res = await fetch(`${CORE_URL}/api/stores/${id}/sync`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        const error = data.error || "Sync failed";
        setStoreSyncErrors((prev) => ({ ...prev, [id]: error }));
        toast.error(error);
        return;
      }
      setStoreSyncErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast.success("Synced");
      fetchStores();
    } catch {
      setStoreSyncErrors((prev) => ({ ...prev, [id]: "Could not reach Talome Core" }));
      toast.error("Sync failed");
    } finally {
      setSyncingStore(null);
    }
  };

  const handleRemoveStore = async (id: string) => {
    try {
      await fetch(`${CORE_URL}/api/stores/${id}`, { method: "DELETE" });
      toast.success("Store removed");
      fetchStores();
    } catch {
      toast.error("Failed to remove");
    }
  };

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        App sources are Git repositories that provide installable app definitions. Talome ships with built-in sources and you can add CasaOS, Umbrel, or custom stores.
      </p>

      {/* Sources list */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-sm font-medium text-foreground">Sources</p>
          {storeSources.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {storeSources.length}
            </span>
          )}
        </SettingsRow>

        {storesError && (
          <SettingsRow className="items-start">
            <div className="flex-1">
              <p className="text-sm text-destructive">{storesError}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Start Talome Core and retry loading this section.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs px-3"
              onClick={() => { void fetchStores(); }}
            >
              Retry
            </Button>
          </SettingsRow>
        )}

        {storesLoading && storeSources.length === 0 && !storesError && (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">Loading app sources...</p>
          </SettingsRow>
        )}

        {!storesLoading && !storesError && storeSources.length === 0 && (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">
              No app sources yet. Add one below.
            </p>
          </SettingsRow>
        )}

        {storeSources.map((store) => {
          const isSyncing = syncingStore === store.id;
          const hasSynced = !!store.lastSyncedAt;
          const syncError = storeSyncErrors[store.id];
          return (
            <SettingsRow key={store.id} className="flex-col items-stretch gap-3 py-4 @lg:flex-row @lg:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">{store.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className="text-muted-foreground">{store.type === "casaos" ? "CasaOS" : store.type === "umbrel" ? "Umbrel" : store.type === "user-created" ? "Custom apps" : "Talome"}</span>
                  {" · "}{store.appCount} {store.appCount === 1 ? "app" : "apps"}
                  {isSyncing ? (
                    <span> · Syncing</span>
                  ) : hasSynced ? (
                    <> · Updated {relativeTime(store.lastSyncedAt!)}</>
                  ) : (
                    <span className="text-status-warning"> · never synced</span>
                  )}
                </p>
                {syncError && (
                  <p className="text-xs text-destructive mt-1 break-words">{syncError}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-coarse:min-h-11"
                  aria-label={`${hasSynced ? "Re-sync" : "Sync"} ${store.name}`}
                  busy={isSyncing}
                  busyLabel={`Syncing ${store.name}`}
                  onClick={() => void handleSyncStore(store.id)}
                  disabled={isSyncing}
                >
                  <HugeiconsIcon icon={Refresh04Icon} size={16} />
                  {hasSynced ? "Re-sync" : "Sync"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11" aria-label={`Actions for ${store.name}`} disabled={isSyncing}>
                      <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => void handleRemoveStore(store.id)}>
                      <HugeiconsIcon icon={Delete02Icon} size={16} />
                      Remove source
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      {/* Add source */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-sm font-medium text-foreground">Add source</p>
        </SettingsRow>
        <SettingsRow className="flex-col items-stretch gap-4 py-4">
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="store-name" className="text-xs text-muted-foreground">Name</Label>
              <Input
                id="store-name"
                placeholder="My Store"
                value={newStoreName}
                onChange={(e) => setNewStoreName(e.target.value)}
                className="h-9 sm:h-8 text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="store-url" className="text-xs text-muted-foreground">Git URL</Label>
              <Input
                id="store-url"
                placeholder="https://github.com/..."
                value={newStoreUrl}
                onChange={(e) => setNewStoreUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleAddStore(); }}
                className="h-9 sm:h-8 text-sm"
              />
            </div>
          </div>
          <Button
            size="sm"
            className="h-9 sm:h-8 text-xs px-5 w-full @lg:w-auto @lg:self-end"
            onClick={handleAddStore}
            disabled={addingStore || !newStoreName || !newStoreUrl}
          >
            {addingStore ? "Adding..." : "Add source"}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
