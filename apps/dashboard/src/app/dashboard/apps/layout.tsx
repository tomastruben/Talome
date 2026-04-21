"use client";

import { StackLayout } from "@/components/layout/stack-layout";

export default function AppsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StackLayout rootPath="/dashboard/apps">{children}</StackLayout>
  );
}
