"use client";

import { useParams } from "next/navigation";
import { NativeAppRuntime } from "@/components/native-app/native-app-runtime";

export default function NativeAppPage() {
  const { storeId, appId } = useParams<{ storeId: string; appId: string }>();
  return <NativeAppRuntime storeId={storeId} appId={appId} />;
}
