import { Setting, requestUrl } from "obsidian";
import type { DarjeelingSettingTab } from "../tab";
import { checkAgentVersion, checkProtocolCompatibility } from "../../errors";

export function displayDirectApiDiagnostics(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement,
  showHeading = false
): void {
  const plugin = tab.plugin;
  if (showHeading) {
    new Setting(containerEl).setName("Direct API verification").setHeading();
  }

  let diagOutput: HTMLElement | null = null;
  const provider = plugin.settings.directApiProvider;

  new Setting(containerEl)
    .setName("Test connection")
    .setDesc(`Verify that your API key and endpoint for ${provider} are reachable and authenticated.`)
    .addButton((btn) => {
      btn.setButtonText("Test connection").setCta().onClick(async () => {
        diagOutput?.remove();
        diagOutput = containerEl.createDiv({ cls: "dj-diag" });
        diagOutput.setText(`Connecting to ${provider}...`);
        try {
          const runner = plugin.agentClient?.directRunner;
          const res = runner
            ? await runner.testConnection(provider)
            : { ok: false, message: "Direct runner not initialized" };
          diagOutput.removeClass("is-ok", "is-fail");
          diagOutput.addClass(res.ok ? "is-ok" : "is-fail");
          diagOutput.setText(res.ok ? `SUCCESS: ${res.message}` : `FAILED: ${res.message}`);
        } catch (err: unknown) {
          diagOutput.removeClass("is-ok");
          diagOutput.addClass("is-fail");
          const msg = err instanceof Error ? err.message : String(err);
          diagOutput.setText(`Error: ${msg}`);
        }
      });
    });
}

export function displayRemoteDiagnostics(
  tab: DarjeelingSettingTab,
  containerEl: HTMLElement,
  showHeading = false
): void {
  if (showHeading) {
    new Setting(containerEl).setName("Remote diagnostics").setHeading();
  }

  let output: HTMLElement | null = null;

  new Setting(containerEl)
    .setName("Check host")
    .setDesc("Verify reachability, protocol compatibility, installed agents, CLI versions, and vault state.")
    .addButton((btn) =>
      btn
        .setButtonText("Run diagnostics")
        .setCta()
        .onClick(async () => {
          output?.remove();
          output = containerEl.createDiv({ cls: "dj-diag" });
          output.setText("Contacting host…");
          await runRemoteDiagnostics(tab, output);
        })
    );
}

export async function runRemoteDiagnostics(
  tab: DarjeelingSettingTab,
  target: HTMLElement
): Promise<void> {
  const plugin = tab.plugin;
  const base = plugin.agentClient?.getBaseUrl?.() ?? `http://${plugin.settings.meshnetHost}:${plugin.settings.port}`;
  const authToken = plugin.agentClient?.getAuthToken?.() ?? "";
  const lines: string[] = [];
  let isWarn = false;

  try {
    // egress: host-http
    const health = await requestUrl({ url: `${base}/health`, method: "GET" });
    const info = (health.json ?? {}) as Record<string, unknown>;
    const vStr = typeof info.version === "string" || typeof info.version === "number" ? String(info.version) : "unknown";
    lines.push(`Reachable — Darjeeling v${vStr}`);

    // Protocol check (Task 3)
    const protoCheck = checkProtocolCompatibility(info);
    if (!protoCheck.ok) {
      isWarn = true;
      lines.push(`Protocol:  ${protoCheck.message}`);
    } else {
      const apiStr = typeof info.api === "number" || typeof info.api === "string" ? String(info.api) : "2";
      lines.push(`Protocol:  API v${apiStr} (compatible)`);
    }

    const vaultPathStr = typeof info.vault_path === "string" ? info.vault_path : "n/a";
    const vaultExistsStr = String(Boolean(info.vault_exists));
    lines.push(`Vault      ${vaultPathStr} (exists: ${vaultExistsStr})`);

    const authRequired = Boolean(info.auth_required);
    lines.push(`Auth       ${authRequired ? "token required" : "DISABLED ON HOST"}`);

    if (plugin.sessionManager.lastAuthError) {
      lines.push(`Auth Error: ${plugin.sessionManager.lastAuthError}`);
      isWarn = true;
    }

    const agentMap = (info.agents ?? {}) as Record<string, boolean>;
    for (const [key, ok] of Object.entries(agentMap)) {
      lines.push(`Agent      ${key}: ${ok ? "installed" : "NOT installed"}`);
    }

    if (authRequired && !authToken) {
      lines.push("");
      lines.push("The host requires a token and none is set here. Paste it above.");
      target.removeClass("is-ok", "is-warn");
      target.addClass("is-fail");
      target.setText(lines.join("\n"));
      return;
    }

    const agents = await plugin.refreshAgents();
    if (agents.length) {
      lines.push("");
      for (const agent of agents) {
        lines.push(
          `${agent.label.padEnd(16)} ${agent.available ? "ready" : "unavailable"}` +
            `${agent.version ? ` — ${agent.version}` : ""}`
        );
        // Agent version check against tested range (G-47)
        const versionWarn = checkAgentVersion(agent.key, agent.version);
        if (versionWarn) {
          isWarn = true;
          lines.push(`  ! Warning: ${versionWarn}`);
        }
        if (agent.available) {
          lines.push(`  models  ${agent.models.map((m) => m.id || "default").join(", ")}`);
          lines.push(`  efforts ${agent.efforts.join(", ")}`);
        }
      }
    }

    const vault = await plugin.sessionManager.getVaultStatus();
    if (vault) {
      lines.push("");
      lines.push(
        `Mirror     ${vault.file_count} files, ` +
          `${(vault.total_size_bytes / 1024 / 1024).toFixed(1)} MB`
      );
    }

    if (!authRequired) {
      lines.push("");
      lines.push(
        "Warning: the host accepts unauthenticated requests. Set DARJEELING_TOKEN " +
          "and restart darjeeling.service."
      );
      isWarn = true;
    }

    if (isWarn) {
      target.removeClass("is-ok", "is-fail");
      target.addClass("is-warn");
    } else {
      target.removeClass("is-warn", "is-fail");
      target.addClass("is-ok");
    }
    target.setText(lines.join("\n"));
  } catch (err) {
    target.removeClass("is-ok", "is-warn");
    target.addClass("is-fail");
    target.setText(
      `Unreachable: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `Tried ${base}/health\n` +
        "Check network connection and that darjeeling.service is running on the host."
    );
  }
}
