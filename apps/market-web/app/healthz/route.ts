// Liveness/readiness probe target. Returns 200 with no auth so the k8s web
// Deployment probes pass regardless of REQUIRE_LOGIN (the require-login gate in
// middleware.ts exempts `/healthz`). Never hits the backend or a session — it is
// purely "the process is up and serving".
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
