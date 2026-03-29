import { Hono } from "hono";
import { listCommunitySubmissions, reviewCommunitySubmission, submitCommunityBundle } from "../stores/community-pipeline.js";

const community = new Hono();

community.get("/submissions", (c) => {
  const status = c.req.query("status") as "pending_review" | "approved" | "rejected" | undefined;
  const submissions = listCommunitySubmissions(status);
  return c.json(submissions);
});

community.post("/submissions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const bundle = body.bundle;
  const authorName = body.authorName || "Unknown";
  const authorEmail = body.authorEmail;

  const result = await submitCommunityBundle({ bundle, authorName, authorEmail });
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, submissionId: result.submissionId, checks: result.checks });
});

community.post("/submissions/:id/review", async (c) => {
  const submissionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const decision = body.decision as "approved" | "rejected" | undefined;
  const notes = body.notes as string | undefined;
  if (!decision || (decision !== "approved" && decision !== "rejected")) {
    return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }

  const result = await reviewCommunitySubmission(submissionId, decision, notes);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

export { community };
