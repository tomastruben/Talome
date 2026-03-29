export function ScreenshotPlaceholder({
  description,
  aspect = "16/10",
}: {
  description: string;
  aspect?: string;
}) {
  return (
    <div
      className="relative my-6 overflow-hidden rounded-2xl border border-border/15 bg-card/8"
      style={{ aspectRatio: aspect }}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle, oklch(1 0 0 / 3%) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="max-w-xs text-center text-sm text-muted-foreground/40">
          Screenshot: {description}
        </p>
      </div>
    </div>
  );
}
