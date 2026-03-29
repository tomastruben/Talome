"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon, CheckmarkCircle01Icon, Cancel01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";

interface ReviewSubmission {
  id: string;
  appId: string;
  appName: string;
  authorName: string;
  status: "pending_review" | "approved" | "rejected";
  checks: { id: string; label: string; status: "passed" | "failed"; details?: string }[];
  createdAt: string;
}

export function CommunityReviewSection() {
  const [submissions, setSubmissions] = useState<ReviewSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const fetchSubmissions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${CORE_URL}/api/community/submissions?status=pending_review`);
      const data = await res.json();
      setSubmissions(Array.isArray(data) ? data : []);
    } catch {
      setSubmissions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSubmissions();
  }, [fetchSubmissions]);

  const review = async (id: string, decision: "approved" | "rejected") => {
    setReviewing(id);
    try {
      const res = await fetch(`${CORE_URL}/api/community/submissions/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Review failed");
      }
      toast.success(decision === "approved" ? "Submission approved" : "Submission rejected");
      await fetchSubmissions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to review submission");
    } finally {
      setReviewing(null);
    }
  };

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Apps submitted by users go through automated checks and then appear here for manual review before being published to the community store.
      </p>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pending Review</p>
          {submissions.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs px-1.5 py-0 tabular-nums">
              {submissions.length}
            </Badge>
          )}
        </SettingsRow>

        {loading && submissions.length === 0 && (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">Loading submissions...</p>
          </SettingsRow>
        )}

        {!loading && submissions.length === 0 && (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">No pending submissions. All clear.</p>
          </SettingsRow>
        )}

        {submissions.map((submission) => (
          <SettingsRow key={submission.id} className="flex-col items-stretch gap-3 py-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{submission.appName}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  by {submission.authorName} · {relativeTime(submission.createdAt)}
                </p>
              </div>
              <Badge variant="outline" className="text-xs shrink-0">{submission.appId}</Badge>
            </div>

            {/* Automated checks */}
            <div className="grid gap-1">
              {submission.checks.map((check) => (
                <div key={check.id} className="flex items-center gap-2">
                  <HugeiconsIcon
                    icon={check.status === "passed" ? CheckmarkCircle01Icon : Cancel01Icon}
                    size={12}
                    className={check.status === "passed" ? "text-status-healthy" : "text-destructive"}
                  />
                  <span className={`text-xs ${check.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {check.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-xs px-4"
                disabled={reviewing === submission.id}
                onClick={() => void review(submission.id, "approved")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive/80 hover:text-destructive"
                disabled={reviewing === submission.id}
                onClick={() => void review(submission.id, "rejected")}
              >
                Reject
              </Button>
            </div>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  );
}
