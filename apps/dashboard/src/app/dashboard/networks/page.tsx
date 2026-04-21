import { redirect } from "next/navigation";

export default function NetworksRedirect() {
  redirect("/dashboard/settings/networking");
}
