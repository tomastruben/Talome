"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TOAST_DURATION } from "@/lib/toast";

interface PendingDelete {
  timer: ReturnType<typeof setTimeout>;
  label: string;
  toastId: string | number;
}

/**
 * Delete with Undo instead of a dialog: the item disappears at once, a toast
 * offers Undo for 6s, and only then is it deleted on the server. Leaving the
 * page (or unmounting) deletes whatever is still pending, so nothing is left
 * half-done. A failed delete brings the item back with an error that says so.
 */
export function useUndoableDelete(remove: (id: string) => Promise<boolean>) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useRef(new Map<string, PendingDelete>());
  const removeRef = useRef(remove);
  useEffect(() => {
    removeRef.current = remove;
  }, [remove]);

  const drop = useCallback((id: string) => {
    entries.current.delete(id);
    setPending((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const commit = useCallback(async (id: string) => {
    const entry = entries.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entries.current.delete(id);
    const ok = await removeRef.current(id).catch(() => false);
    drop(id);
    if (!ok) toast.error(`Couldn't delete "${entry.label}". It's back in the list, so try again.`);
  }, [drop]);

  const undo = useCallback((id: string) => {
    const entry = entries.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    toast.dismiss(entry.toastId);
    drop(id);
  }, [drop]);

  const request = useCallback((id: string, label: string) => {
    if (entries.current.has(id)) return;
    const toastId = toast(`Deleted "${label}"`, {
      duration: TOAST_DURATION.undo,
      action: { label: "Undo", onClick: () => undo(id) },
    });
    const timer = setTimeout(() => void commit(id), TOAST_DURATION.undo);
    entries.current.set(id, { timer, label, toastId });
    setPending((current) => new Set(current).add(id));
  }, [commit, undo]);

  // Leaving the page finishes what was asked for.
  useEffect(() => {
    const map = entries.current;
    const flush = () => {
      for (const id of [...map.keys()]) void commit(id);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [commit]);

  return { pending, request, undo };
}
