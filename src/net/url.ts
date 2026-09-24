import { Platform } from "obsidian";

/**
 * Checks if an IPv4 address string falls within private or loopback ranges:
 * - Loopback: 127.0.0.0/8
 * - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - CGNAT / Tailscale / NordVPN Meshnet: 100.64.0.0/10
 */
export function isPrivateOrLoopbackIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [b0, b1] = parts;
  // 127.0.0.0/8
  if (b0 === 127) return true;
  // 10.0.0.0/8
  if (b0 === 10) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.168.0.0/16
  if (b0 === 192 && b1 === 168) return true;
  // 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  return false;
}

/**
 * Checks if an IPv6 address string is loopback (::1), link-local (fe80::/10), or ULA (fc00::/7).
 */
export function isPrivateOrLoopbackIpv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return true;
  if (clean.startsWith("fe8") || clean.startsWith("fe9") || clean.startsWith("fea") || clean.startsWith("feb")) {
    return true;
  }
  if (clean.startsWith("fc") || clean.startsWith("fd")) {
    return true;
  }
  return false;
}

export function isNumericIp(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, "");
  // IPv4 regex
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(clean)) return true;
  // IPv6 contains colons
  if (clean.includes(":")) return true;
  return false;
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "localhost" || clean === "127.0.0.1" || clean === "::1") return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(clean)) {
    return isPrivateOrLoopbackIpv4(clean);
  }
  if (clean.includes(":")) {
    return isPrivateOrLoopbackIpv6(clean);
  }
  return false;
}

/**
 * Formats a host and port into a valid URL host string, bracketing IPv6 if necessary.
 */
export function formatHostAddress(host: string, port?: number): string {
  let formatted = host.trim();
  if (formatted.includes(":") && !formatted.startsWith("[") && !formatted.endsWith("]")) {
    formatted = `[${formatted}]`;
  }
  if (port !== undefined && port > 0) {
    formatted = `${formatted}:${port}`;
  }
  return formatted;
}

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
  warning?: string;
}

/**
 * Validates a Darjeeling host URL (CHAT-37, INST-12, F-23, CORE-29, OBS-10).
 * - Enforces http:// or https://.
 * - Brackets unbracketed IPv6.
 * - On iOS: refuses http:// to domain names (ATS).
 * - Warns for http:// outside loopback, RFC 1918, and 100.64/10.
 */
export function validateHostUrl(rawUrl: string, isIosOverride?: boolean): UrlValidationResult {
  if (!rawUrl || !rawUrl.trim()) {
    return { valid: false, error: "Host URL cannot be empty." };
  }

  let input = rawUrl.trim();
  if (!/^https?:\/\//i.test(input)) {
    input = `http://${input}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (err) {
    return { valid: false, error: `Invalid host URL: ${String(err)}` };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { valid: false, error: `Unsupported protocol "${protocol}". Use http:// or https://.` };
  }

  const hostname = parsed.hostname;
  const isIos = isIosOverride ?? Boolean(Platform?.isIosApp);

  // iOS App Transport Security (ATS) refusal for unencrypted domain names
  if (isIos && protocol === "http:") {
    const isIp = isNumericIp(hostname);
    const isLocalhost = hostname.toLowerCase() === "localhost";
    if (!isIp && !isLocalhost) {
      return {
        valid: false,
        error:
          "iOS App Transport Security (ATS) blocks unencrypted HTTP to domain names. Use HTTPS or an IP address (e.g. 100.x.x.x or 192.168.x.x).",
      };
    }
  }

  let warning: string | undefined;
  if (protocol === "http:") {
    const isPrivate = isPrivateOrLoopbackHost(hostname);
    if (!isPrivate) {
      warning =
        "Connecting over unencrypted HTTP outside a private network (RFC 1918 / 100.64.0.0/10) exposes traffic. HTTPS is recommended.";
    }
  }

  // Ensure normalized URL string
  const normalizedUrl = parsed.toString().replace(/\/$/, "");
  return {
    valid: true,
    normalizedUrl,
    warning,
  };
}

/**
 * Converts an HTTP/HTTPS base URL to a corresponding WS/WSS URL with optional endpoint path.
 */
export function toWebSocketUrl(httpBaseUrl: string, endpointPath = "/ws/agent"): string {
  const validation = validateHostUrl(httpBaseUrl);
  const base = validation.normalizedUrl || httpBaseUrl.trim().replace(/\/$/, "");
  const parsed = new URL(base);

  const wsProto = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.protocol = wsProto;

  const path = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  parsed.pathname = path;

  return parsed.toString();
}
