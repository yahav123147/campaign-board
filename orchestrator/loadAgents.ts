import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Agent, AgentMeta } from "@/types";

const AGENTS_DIR = path.resolve(process.cwd(), "agents");

export async function loadAgents(): Promise<Agent[]> {
  const dirs = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
  const agentDirs = dirs.filter(d => d.isDirectory()).map(d => d.name);

  const agents: Agent[] = [];

  for (const dir of agentDirs) {
    const agentPath = path.join(AGENTS_DIR, dir);
    const jsonPath = path.join(agentPath, "agent.json");
    const promptPath = path.join(agentPath, "prompt.md");

    const meta: AgentMeta = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
    const promptRaw = await fs.readFile(promptPath, "utf-8");
    const { content } = matter(promptRaw);

    agents.push({
      ...meta,
      systemPrompt: content.trim(),
      avatarPath: path.join(agentPath, "avatar.png"),
    });
  }

  return agents.sort((a, b) => a.order - b.order);
}
