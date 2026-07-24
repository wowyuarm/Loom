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
  attachmentStoreRoot: string;
  workspaceRoot: string;
  runtimeRoot: string;
  mainTranscriptDirectory: string;
  organTranscriptRoot: string;
  backupRoot: string;
}

export function resolveInstanceLayout(root: string): InstanceLayout {
  const resolvedRoot = path.resolve(root);
  const configurationRoot = path.join(resolvedRoot, "configuration");
  const piRoot = path.join(configurationRoot, "pi");
  const weixinRoot = path.join(configurationRoot, "integrations", "weixin");
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
    weixinStateFile: path.join(resolvedRoot, "runtime", "integrations", "weixin.db"),
    attachmentStoreRoot: path.join(resolvedRoot, "runtime", "integrations", "attachments"),
    workspaceRoot: path.join(resolvedRoot, "workspace"),
    runtimeRoot: path.join(resolvedRoot, "runtime"),
    mainTranscriptDirectory: path.join(transcriptRoot, "main"),
    organTranscriptRoot: path.join(transcriptRoot, "organs"),
    backupRoot: path.join(resolvedRoot, "backups"),
  };
}
