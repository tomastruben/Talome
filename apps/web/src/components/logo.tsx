/**
 * Talome logo — dot-only double helix.
 * 1.5 turns, 7 dots per strand, wide amplitude, tight vertical.
 * Depth encoded as circle radius + opacity.
 */

// Precomputed dots: n=7, turns=1.5, amp=5.5, cx=12, top=4.5, height=15
// minR=0.6, maxR=1.7, minO=0.12, maxO=1
const DOTS: { cx: number; cy: number; r: number; o: number }[] = (() => {
  const result: { cx: number; cy: number; r: number; o: number }[] = [];
  const n = 7, turns = 1.5, amp = 5.5, cx = 12, top = 4.5, height = 15;
  for (let strand = 0; strand < 2; strand++) {
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * Math.PI * 2 * turns + strand * Math.PI;
      const depth = (Math.cos(t) + 1) / 2;
      result.push({
        cx: cx + amp * Math.sin(t),
        cy: top + (height * i) / (n - 1),
        r: 0.6 + depth * 1.1,
        o: 0.12 + depth * 0.88,
      });
    }
  }
  return result;
})();

function TalomeMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      {DOTS.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r} opacity={d.o} />
      ))}
    </svg>
  );
}

export const Logo = () => (
  <span className="flex items-center gap-2.5">
    <TalomeMark size={24} />
    <span className="text-lg font-medium tracking-tight text-foreground">
      Talome
    </span>
  </span>
);
