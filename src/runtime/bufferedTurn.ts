import { Notice, requestUrl } from "obsidian";
import type { AgentEvent, TurnOptions } from "../net/agentClient";
import type DarjeelingPlugin from "../main";
import { clampToSupported, CanonicalPermissionMode } from "../models/permissions";
import { isBypassConfirmedForConversation } from "../ui/modals/confirm";
import { getAgentPermissionModes } from "./agents";

/**
 * Buffered turn. Uses direct API or local CLI runner if configured, or
 * falls back to the remote host REST API.
 * Buffered and plan turns NEVER write the chat pointer (CORE-09, CHAT-05, PD-17, PD-39).
 */
export async function runBufferedTurn(
  plugin: DarjeelingPlugin,
  options: TurnOptions
): Promise<AgentEvent[] | null> {
  const requestedMode = options.permission_mode ?? plugin.settings.permissionMode;
  const conversationId = options.resume ?? plugin.settings.lastAgentSessionId;
  let clampedMode: CanonicalPermissionMode;

  if (requestedMode === "bypassPermissions" && !isBypassConfirmedForConversation(conversationId)) {
    clampedMode = "plan";
  } else {
    const supported = getAgentPermissionModes(options.agent || plugin.settings.agent);
    clampedMode = clampToSupported(requestedMode, supported);
  }
  options.permission_mode = clampedMode;

  const mode = plugin.agentClient?.getEffectiveRuntimeMode?.() ?? plugin.settings.runtimeMode;
  if (mode === "direct-api") {
    return plugin.agentClient.directRunner.runBuffered(options);
  }
  if (mode === "local") {
    return plugin.agentClient.localRunner.runBuffered(options);
  }

  const baseUrl = plugin.agentClient?.getBaseUrl?.() ?? `http://${plugin.settings.meshnetHost}:${plugin.settings.port}`;
  const authToken = plugin.agentClient?.getAuthToken?.() ?? plugin.settings.authToken;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["X-Darjeeling-Token"] = authToken;
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    // egress: host-http
    const res = await requestUrl({
      url: `${baseUrl}/api/agent/turn`,
      method: "POST",
      headers,
      body: JSON.stringify(options),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const detail = (() => {
        try {
          return (res.json as { detail?: string })?.detail;
        } catch {
          return undefined;
        }
      })();
      new Notice(`Host returned ${res.status}${detail ? `: ${detail}` : ""}`);
      return null;
    }

    const body = res.json as { events?: AgentEvent[]; sessionId?: string };
    // Buffered turns NEVER write the chat pointer (PD-17, PD-39).
    return body.events ?? [];
  } catch (err) {
    console.error("[Darjeeling] buffered turn failed:", err);
    return null;
  }
}
