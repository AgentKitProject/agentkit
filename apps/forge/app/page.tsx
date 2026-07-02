import { redirect } from "next/navigation";

// Root permanently redirects to the app entry point.
// /health and /api/* are unaffected (matched before this page).
export default function HomePage() {
  redirect("/forge");
}
