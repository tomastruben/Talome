"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";

interface RebuildResponse {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  buildError?: string;
  duration?: number;
  error?: string;
}

/**
 * Whether a rebuild this page started is still running. It lives outside the
 * button so the busy state stays true when the row unmounts and comes back
 * (moving between Settings sections while the build runs), and a second press
 * never starts a second build.
 */
let rebuilding = false;
const listeners = new Set<() => void>();
function setRebuilding(next: boolean) {
  rebuilding = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const getRebuilding = () => rebuilding;
const getServerRebuilding = () => false;

async function runRebuild() {
  if (rebuilding) return;
  setRebuilding(true);
  try {
    const res = await fetch(`${CORE_URL}/api/evolution/rebuild-dashboard`, {
      method: "POST",
      credentials: "include",
    });
    const data = (await res.json().catch(() => ({}))) as RebuildResponse;

    if (!res.ok && !data.buildError) {
      toast.error("Couldn't rebuild Talome", {
        description: data.error ?? `The server answered ${res.status}. Check that it's running, then try again.`,
      });
      return;
    }
    if (data.skipped) {
      toast("Nothing to rebuild", { description: "The development server reloads changes on its own." });
      return;
    }
    if (data.ok) {
      const seconds = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format((data.duration ?? 0) / 1000);
      toast.success(`Rebuilt Talome in ${seconds} s`, { description: "Refresh the page to see the changes." });
      return;
    }

    const toastId = toast.error("The build failed", {
      description: "Claude Code can try to fix it.",
      duration: 10000,
      action: {
        label: "Fix",
        onClick: async () => {
          toast.dismiss(toastId);
          toast.loading("Starting the fix…", { id: "autofix" });
          try {
            const fixRes = await fetch(`${CORE_URL}/api/evolution/rebuild-dashboard/autofix`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ buildError: data.buildError }),
            });
            const fixData = (await fixRes.json().catch(() => ({}))) as { ok?: boolean };
            if (fixRes.ok && fixData.ok) {
              toast.success("Fix started", { id: "autofix", description: "Follow it on the Intelligence page." });
            } else {
              toast.error("Couldn't start the fix", { id: "autofix", description: "Try again, or fix the build in the Terminal." });
            }
          } catch {
            toast.error("Couldn't reach the Talome server", { id: "autofix", description: "Check that it's running, then try again." });
          }
        },
      },
    });
  } catch {
    toast.error("Couldn't reach the Talome server", { description: "Check that it's running, then try again." });
  } finally {
    setRebuilding(false);
  }
}

/**
 * Rebuilds the Talome dashboard after code changes (admins, production
 * builds; a development server hot-reloads instead).
 *
 * It used to sit in the Terminal toolbar, where it had nothing to do with the
 * shell session. It lives on a Settings row now, beside Server mode (admins
 * only, like the endpoint): the button shows the work in flight with its busy
 * state, and the outcome is reported as a toast, never as coloured button text.
 * `aria-describedby` lets that row tie the short "Rebuild" to its label.
 */
export function RebuildDashboardButton({
  className,
  "aria-describedby": describedBy,
}: {
  className?: string;
  "aria-describedby"?: string;
}) {
  const building = useSyncExternalStore(subscribe, getRebuilding, getServerRebuilding);

  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      aria-describedby={describedBy}
      busy={building}
      busyLabel="Rebuilding…"
      onClick={() => void runRebuild()}
    >
      Rebuild
    </Button>
  );
}
