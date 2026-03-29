"use client";

/**
 * Last-resort error boundary for the entire Next.js app.
 * When everything else fails, this still renders — giving the user
 * access to the terminal (which connects directly to the daemon on :4001,
 * independent of the frontend) so they can fix the issue.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ backgroundColor: "#1a1a1a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "2rem", gap: "1.5rem" }}>
          <p style={{ fontSize: "4rem", lineHeight: 1, fontWeight: 400, color: "#555", margin: 0, userSelect: "none" }}>
            Error
          </p>
          <p style={{ fontSize: "0.875rem", color: "#999", maxWidth: "24rem", textAlign: "center", margin: 0 }}>
            {error.message || "Something went wrong."}
          </p>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              onClick={reset}
              style={{
                padding: "0.5rem 1rem", fontSize: "0.875rem", borderRadius: "0.375rem",
                border: "1px solid #333", backgroundColor: "#262626", color: "#e5e5e5",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/dashboard/terminal"
              style={{
                padding: "0.5rem 1rem", fontSize: "0.875rem", borderRadius: "0.375rem",
                border: "1px solid #333", backgroundColor: "#262626", color: "#e5e5e5",
                textDecoration: "none", display: "inline-flex", alignItems: "center",
              }}
            >
              Open Terminal
            </a>
          </div>
          <p style={{ fontSize: "0.75rem", color: "#666", marginTop: "1rem", maxWidth: "28rem", textAlign: "center" }}>
            The terminal connects directly to the server daemon and works
            independently of the dashboard. Use it to inspect logs or fix issues.
          </p>
        </div>
      </body>
    </html>
  );
}
