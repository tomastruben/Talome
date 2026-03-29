/**
 * Logo finalist — Wide (amp 5.5), 1.5 turns, 7 dots per strand.
 * Exploring depth curves, dot sizing, opacity ranges.
 */

type Dot = { x: number; y: number; r: number; o: number };

function helix({
  minR = 0.6,
  maxR = 1.7,
  minO = 0.12,
  maxO = 1,
  top = 3,
  height = 18,
  cx = 12,
}: {
  minR?: number;
  maxR?: number;
  minO?: number;
  maxO?: number;
  top?: number;
  height?: number;
  cx?: number;
} = {}): Dot[] {
  const n = 7, turns = 1.5, amp = 5.5;
  const dots: Dot[] = [];
  for (let strand = 0; strand < 2; strand++) {
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * Math.PI * 2 * turns + strand * Math.PI;
      const depth = (Math.cos(t) + 1) / 2;
      dots.push({
        x: cx + amp * Math.sin(t),
        y: top + (height * i) / (n - 1),
        r: minR + depth * (maxR - minR),
        o: minO + depth * (maxO - minO),
      });
    }
  }
  return dots;
}

const variants: { name: string; dots: Dot[] }[] = [
  { name: "Base wide", dots: helix() },
  { name: "Smaller dots", dots: helix({ minR: 0.5, maxR: 1.3 }) },
  { name: "Bigger dots", dots: helix({ minR: 0.8, maxR: 2.1 }) },
  { name: "Uniform dots, depth via opacity", dots: helix({ minR: 1.2, maxR: 1.2, minO: 0.08, maxO: 1 }) },
  { name: "Soft depth", dots: helix({ minR: 0.7, maxR: 1.5, minO: 0.2, maxO: 0.85 }) },
  { name: "Hard depth", dots: helix({ minR: 0.3, maxR: 2.2, minO: 0.06, maxO: 1 }) },
  { name: "Back almost gone", dots: helix({ minR: 0.4, maxR: 1.8, minO: 0.05, maxO: 1 }) },
  { name: "Tighter vertical", dots: helix({ top: 4.5, height: 15 }) },
  { name: "Taller vertical", dots: helix({ top: 2, height: 20 }) },
  { name: "Left offset", dots: helix({ cx: 11 }) },
  { name: "Bigger, softer", dots: helix({ minR: 0.9, maxR: 2, minO: 0.15, maxO: 0.8 }) },
  { name: "Crisp, even", dots: helix({ minR: 0.9, maxR: 1.6, minO: 0.15, maxO: 1 }) },
];

function DotIcon({ dots, size }: { dots: Dot[]; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} opacity={d.o} />
      ))}
    </svg>
  );
}

export default function LogoExplorer() {
  return (
    <div className="min-h-screen bg-background px-6 py-16 text-foreground md:px-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-medium tracking-tight">
          Wide helix — variants
        </h1>

        <div className="mt-16 space-y-14">
          {variants.map((v, i) => (
            <div key={i} className="space-y-5">
              <p className="text-sm font-medium text-muted-foreground">
                {String(i + 1).padStart(2, "0")}. {v.name}
              </p>
              <div className="flex items-end gap-8">
                {[64, 48, 32, 24, 16].map((size) => (
                  <div key={size} className="flex flex-col items-center gap-2">
                    <DotIcon dots={v.dots} size={size} />
                    <span className="text-[9px] text-muted-foreground/30">{size}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2.5 pl-4">
                  <DotIcon dots={v.dots} size={24} />
                  <span className="text-lg font-medium tracking-tight">Talome</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-24 rounded-2xl bg-white p-10">
          <p className="mb-6 text-sm text-black/40">Light background</p>
          <div className="space-y-6 text-black">
            {variants.map((v, i) => (
              <div key={i} className="flex items-center gap-6">
                <DotIcon dots={v.dots} size={32} />
                <DotIcon dots={v.dots} size={24} />
                <DotIcon dots={v.dots} size={16} />
                <span className="text-sm text-black/50">{v.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
