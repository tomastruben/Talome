import { HugeiconsIcon, PlayIcon } from "@/components/icons";

export function VideoPlaceholder({
  description,
  aspect = "16/9",
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
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-full border border-border/20 bg-card/30">
          <HugeiconsIcon icon={PlayIcon} size={20} className="text-muted-foreground/40" />
        </div>
        <p className="max-w-xs text-center text-sm text-muted-foreground/40">
          {description}
        </p>
      </div>
    </div>
  );
}
