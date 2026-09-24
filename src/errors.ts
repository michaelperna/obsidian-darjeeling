// Shared error helper for the direct-API client, exported so the test suite
// exercises the same code path the plugin ships rather than a re-implemented
// copy (which previously gave false confidence).
export function extractApiError(raw: string): string {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        error?: string | { message?: string };
        message?: string;
      };
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.error?.message === "string") return parsed.error.message;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // not JSON — keep the original text
  }
  return raw;
}

/**
 * Eight canonical connection and runtime error states per AC-17 / G-36:
 * 1. unreachable: Host offline, connection refused, or network failure
 * 2. token_rejected: Bad or missing auth token (HTTP 401 / WS 4401)
 * 3. agent_missing: Requested agent binary not installed on host or desktop
 * 4. not_logged_in: Agent CLI installed but needs user authentication
 * 5. at_capacity: Server concurrent turn limit reached
 * 6. timed_out: Request or turn exceeded timeout deadline
 * 7. protocol_mismatch: Server too old or plugin too old (api vs api_min)
 * 8. pair_device: Host requires pairing or new device authorization
 */
export type Ac17State =
  | "unreachable"
  | "token_rejected"
  | "agent_missing"
  | "not_logged_in"
  | "at_capacity"
  | "timed_out"
  | "protocol_mismatch"
  | "pair_device";

export interface Ac17ErrorInfo {
  state: Ac17State;
  chipLabel: string;
  title: string;
  message: string;
  actionHint: string;
}

export function mapAc17Error(state: Ac17State, details?: string): Ac17ErrorInfo {
  switch (state) {
    case "unreachable":
      return {
        state: "unreachable",
        chipLabel: "Offline",
        title: "Host Unreachable",
        message: details || "Could not connect to the remote host. The server daemon may be offline or the network is down.",
        actionHint: "Verify the host address and ensure darjeeling-server is running.",
      };
    case "token_rejected":
      return {
        state: "token_rejected",
        chipLabel: "Token rejected",
        title: "Authentication Failed",
        message: details || "The server rejected the authentication token (close 4401 or HTTP 401).",
        actionHint: "Re-pair this device or update the auth token in Darjeeling Settings.",
      };
    case "agent_missing":
      return {
        state: "agent_missing",
        chipLabel: "Agent missing",
        title: "Agent Binary Not Found",
        message: details || "The requested agent CLI binary is not installed or not on the executable PATH.",
        actionHint: "Install the agent binary on the host or switch to an available agent.",
      };
    case "not_logged_in":
      return {
        state: "not_logged_in",
        chipLabel: "Not logged in",
        title: "Agent Not Authenticated",
        message: details || "The agent CLI is installed but requires login before running turns.",
        actionHint: "Open the Darjeeling terminal tab and run the agent login command (e.g. claude login).",
      };
    case "at_capacity":
      return {
        state: "at_capacity",
        chipLabel: "At capacity",
        title: "Host Busy",
        message: details || "The server is currently running the maximum number of concurrent turns.",
        actionHint: "Wait for running turns to complete or increase DARJEELING_MAX_CONCURRENT_TURNS.",
      };
    case "timed_out":
      return {
        state: "timed_out",
        chipLabel: "Timed out",
        title: "Request Timed Out",
        message: details || "The connection or turn exceeded the deadline.",
        actionHint: "Check host load or retry with a shorter turn.",
      };
    case "protocol_mismatch":
      return {
        state: "protocol_mismatch",
        chipLabel: "Version mismatch",
        title: "Protocol Mismatch",
        message: details || "The Darjeeling plugin and server protocol versions are incompatible.",
        actionHint: details?.includes("plugin") ? "Update the Darjeeling plugin." : "Update your Darjeeling server.",
      };
    case "pair_device":
      return {
        state: "pair_device",
        chipLabel: "Pair device",
        title: "Device Not Paired",
        message: details || "This device is not paired with the remote host.",
        actionHint: "Use 'Pair this device' in settings or scan the pairing QR code.",
      };
  }
}

/**
 * Validates protocol version from /health response (F-25, G-60).
 * Server returns { api: number, api_min: number }.
 * Current client protocol version is 2, minimum client supported server version is 2.
 */
export const CLIENT_API_VERSION = 2;
export const CLIENT_API_MIN = 2;

export interface ProtocolCheckResult {
  ok: boolean;
  state?: Ac17State;
  message?: string;
}

export function checkProtocolCompatibility(healthData: Record<string, unknown> | null | undefined): ProtocolCheckResult {
  if (!healthData || typeof healthData !== "object") {
    return { ok: false, state: "unreachable", message: "No health response from server." };
  }

  const serverApi = typeof healthData.api === "number" ? healthData.api : undefined;
  const serverApiMin = typeof healthData.api_min === "number" ? healthData.api_min : undefined;

  // Server has no api version advertised -> legacy server
  if (serverApi === undefined) {
    return {
      ok: false,
      state: "protocol_mismatch",
      message: "Update your server: server is running an older protocol version.",
    };
  }

  // Server minimum is newer than client version -> client too old
  if (serverApiMin !== undefined && serverApiMin > CLIENT_API_VERSION) {
    return {
      ok: false,
      state: "protocol_mismatch",
      message: "Update the plugin: server requires a newer protocol version.",
    };
  }

  // Server version is older than client minimum -> server too old
  if (serverApi < CLIENT_API_MIN) {
    return {
      ok: false,
      state: "protocol_mismatch",
      message: "Update your server: server protocol version is too old.",
    };
  }

  return { ok: true };
}

/**
 * Checks an agent CLI version against tested version ranges (G-47).
 * Returns a warning string if outside the tested range, or null if ok/unknown.
 */
export interface AgentVersionRange {
  minVersion: string;
  maxVersion?: string;
}

export const TESTED_AGENT_VERSIONS: Record<string, AgentVersionRange> = {
  claude: { minVersion: "2.1.200", maxVersion: "2.1.999" },
  agy: { minVersion: "0.1.0" },
};

function parseSemver(v: string): number[] | null {
  const clean = v.replace(/^v/i, "").trim();
  const match = clean.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3] || "0", 10)];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function checkAgentVersion(agentKey: string, version: string | null | undefined): string | null {
  if (!version || version === "local" || version === "api") return null;
  const range = TESTED_AGENT_VERSIONS[agentKey.toLowerCase()];
  if (!range) return null;

  if (range.minVersion && compareSemver(version, range.minVersion) < 0) {
    return `Agent ${agentKey} version ${version} is below tested minimum ${range.minVersion}. Some features may not work.`;
  }
  if (range.maxVersion && compareSemver(version, range.maxVersion) > 0) {
    return `Agent ${agentKey} version ${version} is above tested maximum ${range.maxVersion}.`;
  }
  return null;
}
