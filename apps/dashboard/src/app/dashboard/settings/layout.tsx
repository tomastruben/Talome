"use client";

import { StackLayout } from "@/components/layout/stack-layout";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StackLayout rootPath="/dashboard/settings">{children}</StackLayout>
  );
}
