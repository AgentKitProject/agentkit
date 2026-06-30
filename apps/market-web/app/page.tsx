import { redirect } from "next/navigation";

// The Market is now an app (sidebar shell), not a marketing site: "/" is the
// catalog. Redirect to /kits so the old black-wordmark marketing hero and the
// light-on-dark preview cards are gone, and the catalog is the home surface.
export default function Home() {
  redirect("/kits");
}
