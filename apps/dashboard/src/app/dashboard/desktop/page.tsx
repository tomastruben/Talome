"use client";

import { DesktopExperience } from "@/components/desktop/desktop-experience";
import { MotionProvider } from "@/components/motion-provider";

export default function DesktopPage() {
  // The desktop shell (menu bar, windows, dock, Launchpad) honours the OS
  // reduced-motion setting for every motion/react animation.
  return (
    <MotionProvider>
      <DesktopExperience />
    </MotionProvider>
  );
}
