import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  type ModelRuntime,
  type ResourceDiagnostic,
  type Skill,
  type SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { AgentWorkspace } from "../../workspace/agent-workspace.js";

const MAIN_AGENT_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface PiSessionFactoryOptions {
  agentWorkspace: AgentWorkspace;
  agentDir: string;
  transcriptDirectory: string;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  skillSources?: { core: string[]; integrations: string[] };
  additionalTools: ToolDefinition[];
}

export interface PreparedPiSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  acceptedSkillCount: number;
  skillDiagnostics: ResourceDiagnostic[];
}

export type PiSessionFactory = (request: {
  systemPrompt: string;
  turnTools: ToolDefinition[];
  activityExtension: InlineExtension;
  onMessageStart: (message: unknown) => void;
  sessionManager: SessionManager;
}) => Promise<PreparedPiSession>;

export async function createPiSessionFactory(options: PiSessionFactoryOptions): Promise<PiSessionFactory> {
  await Promise.all([
    mkdir(options.agentDir, { recursive: true }),
    mkdir(options.transcriptDirectory, { recursive: true }),
  ]);
  const settingsManager = SettingsManager.create(options.agentWorkspace.root, options.agentDir, { projectTrusted: false });

  return async request => {
    const annotationExtension: InlineExtension = {
      name: "loom-input-annotation",
      factory: pi => {
        pi.on("message_start", event => request.onMessageStart(event.message));
      },
    };
    const workspaceSkills = path.join(options.agentWorkspace.root, "skills");
    const hasWorkspaceSkills = await exists(workspaceSkills);
    const additionalSkillPaths = [
      ...(options.skillSources?.core ?? []),
      ...(hasWorkspaceSkills ? [workspaceSkills] : []),
      ...(options.skillSources?.integrations ?? []),
    ];
    let resourceLoader: DefaultResourceLoader;
    resourceLoader = new DefaultResourceLoader({
      cwd: options.agentWorkspace.root,
      agentDir: options.agentDir,
      settingsManager,
      extensionFactories: [annotationExtension, request.activityExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths,
      skillsOverride: result => resolveSkills(result.skills, result.diagnostics),
      systemPromptOverride: () => appendSkillDiagnostics(request.systemPrompt, resourceLoader.getSkills().diagnostics),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const customTools = [...options.additionalTools, ...request.turnTools];
    const { session } = await createAgentSession({
      cwd: options.agentWorkspace.root,
      agentDir: options.agentDir,
      modelRuntime: options.modelRuntime,
      model: options.model,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      tools: [...MAIN_AGENT_BUILTIN_TOOLS, ...customTools.map(tool => tool.name)],
      customTools,
      resourceLoader,
      sessionManager: request.sessionManager,
      settingsManager,
    });
    session.agent.steeringMode = "all";
    await session.bindExtensions({});
    const finalSkills = resourceLoader.getSkills();
    return { session, acceptedSkillCount: finalSkills.skills.length, skillDiagnostics: finalSkills.diagnostics };
  };
}

function resolveSkills(skills: Skill[], diagnostics: ResourceDiagnostic[]): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const rejectedPaths = new Set(diagnostics.flatMap(diagnostic =>
    diagnostic.type !== "collision" && diagnostic.path ? [diagnostic.path] : []));
  const collisionNames = new Set(diagnostics.flatMap(diagnostic =>
    diagnostic.type === "collision" && diagnostic.collision?.resourceType === "skill" ? [diagnostic.collision.name] : []));
  const manualDiagnostics: ResourceDiagnostic[] = skills.flatMap(skill => skill.disableModelInvocation ? [{
    type: "warning" as const,
    message: `skill "${skill.name}" disables model invocation`,
    path: skill.filePath,
  }] : []);
  return {
    skills: skills.filter(skill => !skill.disableModelInvocation && !rejectedPaths.has(skill.filePath) && !collisionNames.has(skill.name)).sort(compareSkills),
    diagnostics: [...diagnostics, ...manualDiagnostics].sort(compareDiagnostics),
  };
}

function compareSkills(left: Skill, right: Skill): number {
  return compareText(left.name, right.name) || compareText(left.filePath, right.filePath);
}

function compareDiagnostics(left: ResourceDiagnostic, right: ResourceDiagnostic): number {
  return compareText(left.path ?? "", right.path ?? "") || compareText(left.type, right.type) || compareText(left.message, right.message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendSkillDiagnostics(systemPrompt: string, diagnostics: ResourceDiagnostic[]): string {
  if (diagnostics.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n# Skill Diagnostics\n\n${JSON.stringify(diagnostics, null, 2)}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
