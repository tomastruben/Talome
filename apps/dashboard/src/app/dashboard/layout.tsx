import { DashboardShell } from "@/components/layout/dashboard-shell";
import { MotionProvider } from "@/components/motion-provider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reduced motion is honoured for the whole shell (classic mode and every
  // desktop window, which runs this same layout in an iframe).
  return (
    <MotionProvider>
      <DashboardShell>{children}</DashboardShell>
    </MotionProvider>
  );
}
