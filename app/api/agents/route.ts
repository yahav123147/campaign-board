import { NextResponse } from "next/server";
import { loadAgents } from "@/orchestrator/loadAgents";

export async function GET() {
  const agents = await loadAgents();
  return NextResponse.json(
    agents.map(({ slug, name, role, color, order, active }) => ({
      slug,
      name,
      role,
      color,
      order,
      active,
    })),
  );
}
