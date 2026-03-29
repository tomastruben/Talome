import { redirect } from "next/navigation";

export default function BackupsRedirect() {
  redirect("/dashboard/settings/backups");
}
