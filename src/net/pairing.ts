import { requestUrl } from "obsidian";

export interface PairDeviceOptions {
  baseUrl: string;
  code: string;
  deviceName?: string;
  platform?: string;
}

export interface PairDeviceResult {
  token: string;
  deviceId: string;
  serverName: string;
  api: string;
}

import type { AgentDescriptor } from "./agentClient";

export interface VerifyAuthResult {
  ok: boolean;
  agents?: AgentDescriptor[];
  error?: string;
}

export interface RequestPairCodeResult {
  code: string;
  formatted_code: string;
  expires_in: number;
}

/**
 * Validates a server URL according to security constraints (PRD 1.8, ADR-12).
 * Strictly requires http: or https: scheme.
 * Rejects javascript:, data:, file:, or any non-http(s) scheme.
 */
export function validateServerUrl(rawUrl: string): { ok: boolean; url?: string; error?: string } {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { ok: false, error: "Server URL cannot be empty." };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL format." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Disallowed URL protocol: ${parsed.protocol}. Only http: and https: are supported.`,
    };
  }

  // Remove trailing slashes from path
  const cleanUrl =
    parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
  return { ok: true, url: cleanUrl };
}

interface PairApiResponse {
  token?: string;
  device_id?: string;
  server_name?: string;
  api?: string;
}

interface AgentsApiResponse {
  agents?: AgentDescriptor[];
}

interface PairCodeApiResponse {
  code?: string;
  formatted_code?: string;
  expires_in?: number;
}

/**
 * Normalizes an 8-digit pairing code by removing spaces and dashes.
 * Throws if the code is not exactly 8 numeric digits.
 */
export function normalizePairingCode(code: string): string {
  if (!code || typeof code !== "string") {
    throw new Error("Pairing code must be 8 numeric digits.");
  }
  const cleaned = code.trim().replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(cleaned)) {
    throw new Error("Pairing code must be 8 numeric digits.");
  }
  return cleaned;
}

/**
 * Unauthenticated, code-gated pair endpoint (ADR-12, PRD 1.8).
 * POST /api/pair -> { token, device_id, server_name, api }
 */
export async function pairDevice(options: PairDeviceOptions): Promise<PairDeviceResult> {
  const urlValidation = validateServerUrl(options.baseUrl);
  if (!urlValidation.ok || !urlValidation.url) {
    throw new Error(urlValidation.error || "Invalid server URL");
  }

  const cleanCode = normalizePairingCode(options.code);

  const endpoint = `${urlValidation.url}/api/pair`;
  try {
    // egress: host-pairing
    const res = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: cleanCode,
        device_name: options.deviceName || "Obsidian Client",
        platform: options.platform || "unknown",
      }),
      throw: false,
    });

    if (res.status === 200) {
      const data = res.json as PairApiResponse | undefined;
      if (!data?.token || !data?.device_id) {
        throw new Error("Server response missing device credentials.");
      }
      return {
        token: data.token,
        deviceId: data.device_id,
        serverName: data.server_name || "Darjeeling Host",
        api: data.api || "1.0.0",
      };
    }

    if (res.status === 401) {
      throw new Error("Code rejected: invalid, expired, or already used.");
    }
    if (res.status === 429) {
      throw new Error("Too many failed attempts. Please wait before retrying.");
    }
    throw new Error(`Server returned HTTP ${res.status}: ${res.text || "Pairing failed"}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Code rejected")) {
      throw err;
    }
    if (msg.startsWith("Too many failed")) {
      throw err;
    }
    throw new Error(`Failed to pair with server: ${msg}`);
  }
}

/**
 * Authenticated verification of token against GET /api/agents (F-17, G-10).
 * Never fakes 'Connected' if status is not 200.
 */
export async function verifyHostAuthentication(
  baseUrl: string,
  token: string
): Promise<VerifyAuthResult> {
  const urlValidation = validateServerUrl(baseUrl);
  if (!urlValidation.ok || !urlValidation.url) {
    return { ok: false, error: urlValidation.error || "Invalid server URL" };
  }

  const endpoint = `${urlValidation.url}/api/agents`;
  try {
    // egress: host-pairing
    const res = await requestUrl({
      url: endpoint,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      throw: false,
    });

    if (res.status === 200) {
      const data = res.json as AgentsApiResponse | undefined;
      return {
        ok: true,
        agents: Array.isArray(data?.agents) ? data.agents : [],
      };
    }

    if (res.status === 401) {
      return { ok: false, error: "Token rejected by server." };
    }

    return {
      ok: false,
      error: `Server check failed with HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Host unreachable: ${msg}`,
    };
  }
}

/**
 * Authenticated generation of an 8-digit pairing code for "Pair your phone" (PRD 1.8, G-12).
 * POST /api/pair/code -> { code, formatted_code, expires_in }
 */
export async function requestPairCode(
  baseUrl: string,
  token: string
): Promise<RequestPairCodeResult> {
  const urlValidation = validateServerUrl(baseUrl);
  if (!urlValidation.ok || !urlValidation.url) {
    throw new Error(urlValidation.error || "Invalid server URL");
  }

  const endpoint = `${urlValidation.url}/api/pair/code`;
  // egress: host-pairing
  const res = await requestUrl({
    url: endpoint,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    throw: false,
  });

  if (res.status === 200) {
    const data = res.json as PairCodeApiResponse | undefined;
    const code = data?.code || "";
    return {
      code,
      formatted_code: data?.formatted_code || (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code),
      expires_in: data?.expires_in || 600,
    };
  }

  if (res.status === 401) {
    throw new Error("Unauthorized to generate pairing code.");
  }
  throw new Error(`Failed to generate pairing code: HTTP ${res.status}`);
}
