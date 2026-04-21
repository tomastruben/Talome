import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center gap-6">
        <p className="text-[8rem] leading-none font-normal tracking-tight text-dim-foreground select-none">
          404
        </p>
        <p className="text-base text-muted-foreground">
          This page doesn't exist.
        </p>
        <Button variant="secondary" size="sm" asChild>
          <Link href="/dashboard">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
