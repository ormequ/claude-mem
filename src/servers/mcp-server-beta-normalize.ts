import type { ServerBetaAddObservationRequest } from '../services/hooks/server-beta-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeServerBetaProjectId(
  projectId: string | undefined | null,
  settingsProjectId: string,
): string {
  const trimmedProjectId = projectId?.trim();
  if (trimmedProjectId && UUID_RE.test(trimmedProjectId)) {
    return trimmedProjectId;
  }
  return settingsProjectId;
}

export function buildServerBetaObservationAddRequest(input: {
  projectId?: string | null;
  settingsProjectId: string;
  serverSessionId?: string | null;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
}): ServerBetaAddObservationRequest {
  const content = input.content;
  return {
    projectId: normalizeServerBetaProjectId(input.projectId, input.settingsProjectId),
    content,
    narrative: content,
    ...(input.serverSessionId !== undefined ? { serverSessionId: input.serverSessionId } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}
