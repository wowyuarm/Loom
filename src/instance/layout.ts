import path from "node:path";

export interface InstanceLayout {
  root: string;
  configurationFile: string;
  piAgentDirectory: string;
  piAuthFile: string;
  piModelsFile: string;
  piModelsStoreFile: string;
  weixinConfigurationFile: string;
  weixinAuthFile: string;
  weixinStateFile: string;
  raftConfigurationFile: string;
  raftStateFile: string;
  webConfigurationFile: string;
  webAuthFile: string;
  nmemConfigurationFile: string;
  nmemAuthFile: string;
  statusSocketPath: string;
  attachmentStoreRoot: string;
  workspaceRoot: string;
  runtimeRoot: string;
  workspaceMutationRoot: string;
  mainTranscriptDirectory: string;
  organTranscriptRoot: string;
  backupRoot: string;
}

export function resolveInstanceLayout(root: string): InstanceLayout {
  const resolvedRoot = path.resolve(root);
  const configurationRoot = path.join(resolvedRoot, "configuration");
  const piRoot = path.join(configurationRoot, "pi");
  const channelRoot = path.join(configurationRoot, "channels");
  const weixinRoot = path.join(channelRoot, "weixin");
  const raftRoot = path.join(channelRoot, "raft");
  const webRoot = path.join(configurationRoot, "integrations", "web");
  const nmemRoot = path.join(configurationRoot, "integrations", "nmem");
  const transcriptRoot = path.join(resolvedRoot, "transcripts");
  return {
    root: resolvedRoot,
    configurationFile: path.join(configurationRoot, "instance.yaml"),
    piAgentDirectory: piRoot,
    piAuthFile: path.join(piRoot, "auth.json"),
    piModelsFile: path.join(piRoot, "models.json"),
    piModelsStoreFile: path.join(piRoot, "models-store.json"),
    weixinConfigurationFile: path.join(weixinRoot, "config.json"),
    weixinAuthFile: path.join(weixinRoot, "auth.json"),
    weixinStateFile: path.join(resolvedRoot, "runtime", "channels", "weixin.db"),
    raftConfigurationFile: path.join(raftRoot, "config.json"),
    raftStateFile: path.join(resolvedRoot, "runtime", "channels", "raft.db"),
    webConfigurationFile: path.join(webRoot, "config.json"),
    webAuthFile: path.join(webRoot, "auth.json"),
    nmemConfigurationFile: path.join(nmemRoot, "config.json"),
    nmemAuthFile: path.join(nmemRoot, "auth.json"),
    statusSocketPath: path.join(resolvedRoot, "runtime", "status.sock"),
    attachmentStoreRoot: path.join(resolvedRoot, "runtime", "attachments"),
    workspaceRoot: path.join(resolvedRoot, "workspace"),
    runtimeRoot: path.join(resolvedRoot, "runtime"),
    workspaceMutationRoot: path.join(resolvedRoot, "runtime", "workspace-mutations"),
    mainTranscriptDirectory: path.join(transcriptRoot, "main"),
    organTranscriptRoot: path.join(transcriptRoot, "organs"),
    backupRoot: path.join(resolvedRoot, "backups"),
  };
}
