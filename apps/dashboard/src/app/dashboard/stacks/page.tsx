import { redirect } from "next/navigation";

export default function StacksRedirect() {
  redirect("/dashboard/apps");
}
