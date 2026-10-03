"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useContainers } from "@/hooks/use-containers";
import { QuickLookContent } from "@/components/quick-look/quick-look";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { findContainerReference } from "@/lib/container-label";

function ServicePreview() {
  const params = useSearchParams();
  const router = useRouter();
  const { containers, isLoading, error, refresh } = useContainers();
  const id = params.get("id") ?? "";
  const container = findContainerReference(containers, id);
  const port = Number(params.get("port"));
  if (isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (error) return <ErrorState title="Couldn't load this service" onRetry={() => void refresh()} />;
  if (!container) return <EmptyState title="Service unavailable" description="This container may have been removed." />;
  return <QuickLookContent key={`${container.id}:${port}`} standalone container={container} port={Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined} onClose={() => router.back()} />;
}

export default function ServicePreviewPage() {
  return <Suspense fallback={<Spinner />}><ServicePreview /></Suspense>;
}
