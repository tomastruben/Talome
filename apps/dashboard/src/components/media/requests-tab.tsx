"use client";

import Image from "next/image";
import { useState } from "react";
import {
  HugeiconsIcon,
  Film01Icon,
  Tv01Icon,
  Tick01Icon,
  Delete01Icon,
  Notification01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { CORE_URL } from "@/lib/constants";

export interface OverseerrRequest {
  id: number;
  type: "movie" | "tv";
  status: number;
  title: string;
  overview?: string;
  poster?: string;
  tmdbId?: number;
  mediaType?: string;
  requestedBy: string;
  requestedByAvatar?: string;
  createdAt: string;
}

const STATUS_MAP: Record<number, { label: string; color: string }> = {
  1: { label: "Pending", color: "text-status-warning" },
  2: { label: "Approved", color: "text-status-info" },
  3: { label: "Declined", color: "text-destructive" },
  4: { label: "Available", color: "text-status-healthy" },
  5: { label: "Processing", color: "text-status-info" },
};

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending", status: 1 },
  { value: "approved", label: "Approved", status: 2 },
  { value: "available", label: "Available", status: 4 },
  { value: "declined", label: "Declined", status: 3 },
] as const;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function RequestsTab({
  requests,
  onMutate,
}: {
  requests: OverseerrRequest[];
  onMutate: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [actionLoading, setActionLoading] = useState<Record<number, string>>({});

  const filtered = filter === "all"
    ? requests
    : requests.filter((r) => {
        const opt = FILTER_OPTIONS.find((f) => f.value === filter);
        return opt && "status" in opt ? r.status === opt.status : true;
      });

  async function handleAction(id: number, action: "approve" | "decline") {
    setActionLoading((prev) => ({ ...prev, [id]: action }));
    try {
      const res = await fetch(`${CORE_URL}/api/media/requests/${id}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error();
      onMutate();
    } catch { /* toast handled upstream */ }
    setActionLoading((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  if (requests.length === 0) {
    return <EmptyState icon={Notification01Icon} title="No requests" description="Media requests from Overseerr will appear here." />;
  }

  return (
    <div className="grid gap-4">
      {/* Filter pills */}
      <div className="flex gap-1.5 flex-wrap">
        {FILTER_OPTIONS.map((opt) => {
          const count = opt.value === "all"
            ? requests.length
            : requests.filter((r) => "status" in opt && r.status === opt.status).length;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                filter === opt.value
                  ? "bg-foreground/10 text-foreground"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
              {count > 0 && <span className="text-xs opacity-60">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Request cards */}
      <div className="grid gap-2">
        {filtered.map((req) => {
          const status = STATUS_MAP[req.status] ?? { label: String(req.status), color: "text-muted-foreground" };
          const loading = actionLoading[req.id];

          return (
            <div
              key={req.id}
              className="relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch min-h-[80px]"
            >
              {/* Poster strip */}
              <div className="w-14 shrink-0 relative bg-muted/40 border-r border-border/40">
                {req.poster ? (
                  <Image
                    src={req.poster}
                    alt={`${req.title} poster`}
                    className="object-cover"
                    fill
                    decoding="async"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <HugeiconsIcon icon={req.type === "tv" ? Tv01Icon : Film01Icon} size={16} className="text-dim-foreground" />
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 flex items-center gap-3 px-3.5 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate leading-snug">{req.title}</p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {req.requestedBy} · {timeAgo(req.createdAt)}
                  </p>
                  {req.overview && (
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-1">{req.overview}</p>
                  )}
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <span className={`text-xs font-medium ${status.color}`}>{status.label}</span>

                  {req.status === 1 && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        disabled={!!loading}
                        onClick={() => handleAction(req.id, "approve")}
                        aria-label="Approve request"
                      >
                        {loading === "approve" ? (
                          <Spinner className="h-3 w-3" />
                        ) : (
                          <HugeiconsIcon icon={Tick01Icon} size={14} className="text-status-healthy" />
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        disabled={!!loading}
                        onClick={() => handleAction(req.id, "decline")}
                        aria-label="Decline request"
                      >
                        {loading === "decline" ? (
                          <Spinner className="h-3 w-3" />
                        ) : (
                          <HugeiconsIcon icon={Delete01Icon} size={14} className="text-destructive" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
