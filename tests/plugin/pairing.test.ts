import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  validateServerUrl,
  normalizePairingCode,
  pairDevice,
  verifyHostAuthentication,
  requestPairCode,
} from "../../src/net/pairing";
import { setRequestUrlHandler, type RequestUrlParam, type RequestUrlResponse } from "./stubs/obsidian";

describe("Device Pairing and Token Management (S2-W4, ADR-12, PRD 1.8)", () => {
  beforeEach(() => {
    setRequestUrlHandler(null);
  });

  afterEach(() => {
    setRequestUrlHandler(null);
  });

  describe("validateServerUrl", () => {
    it("accepts valid http and https urls and strips trailing slashes", () => {
      const resHttp = validateServerUrl("http://100.64.0.12:8765/");
      assert.equal(resHttp.ok, true);
      assert.equal(resHttp.url, "http://100.64.0.12:8765");

      const resHttps = validateServerUrl("https://darjeeling.tailscale.net:8765");
      assert.equal(resHttps.ok, true);
      assert.equal(resHttps.url, "https://darjeeling.tailscale.net:8765");
    });

    it("rejects malicious or invalid schemes", () => {
      const resJs = validateServerUrl("javascript:alert(1)");
      assert.equal(resJs.ok, false);
      assert.match(resJs.error!, /Only http: and https: are supported/i);

      const resData = validateServerUrl("data:text/html,<html>");
      assert.equal(resData.ok, false);

      const resFtp = validateServerUrl("ftp://100.64.0.12:8765");
      assert.equal(resFtp.ok, false);

      const resEmpty = validateServerUrl("");
      assert.equal(resEmpty.ok, false);
      assert.match(resEmpty.error!, /cannot be empty/i);

      const resGarbage = validateServerUrl("not-a-valid-url");
      assert.equal(resGarbage.ok, false);
      assert.match(resGarbage.error!, /Invalid URL format/);
    });
  });

  describe("normalizePairingCode", () => {
    it("strips whitespace and hyphens from valid 8-digit codes", () => {
      assert.equal(normalizePairingCode("1234 5678"), "12345678");
      assert.equal(normalizePairingCode("1234-5678"), "12345678");
      assert.equal(normalizePairingCode("  12 34 56 78  "), "12345678");
      assert.equal(normalizePairingCode("87654321"), "87654321");
    });

    it("throws on invalid length or characters", () => {
      assert.throws(() => normalizePairingCode("1234"), /8 numeric digits/);
      assert.throws(() => normalizePairingCode("123456789"), /8 numeric digits/);
      assert.throws(() => normalizePairingCode("1234abcd"), /8 numeric digits/);
      assert.throws(() => normalizePairingCode(""), /8 numeric digits/);
    });
  });

  describe("pairDevice", () => {
    it("successfully exchanges pairing code for device token", async () => {
      let capturedRequest: RequestUrlParam | null = null;
      setRequestUrlHandler(async (req) => {
        capturedRequest = req;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            status: "paired",
            token: "secret-bearer-tok-12345",
            device_id: "dev-thinkpad-uuid",
            server_name: "ThinkPad Lab",
            api: "/api/agents",
          }),
          json: {
            status: "paired",
            token: "secret-bearer-tok-12345",
            device_id: "dev-thinkpad-uuid",
            server_name: "ThinkPad Lab",
            api: "/api/agents",
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      const res = await pairDevice({
        baseUrl: "http://100.64.0.12:8765",
        code: "1234 5678",
        deviceName: "MacBook Pro",
        platform: "macos",
      });

      assert.equal(res.token, "secret-bearer-tok-12345");
      assert.equal(res.deviceId, "dev-thinkpad-uuid");
      assert.equal(res.serverName, "ThinkPad Lab");
      assert.equal(res.api, "/api/agents");

      assert.ok(capturedRequest);
      assert.equal((capturedRequest as RequestUrlParam).url, "http://100.64.0.12:8765/api/pair");
      assert.equal((capturedRequest as RequestUrlParam).method, "POST");
      const parsedBody = JSON.parse((capturedRequest as RequestUrlParam).body as string);
      assert.equal(parsedBody.code, "12345678");
      assert.equal(parsedBody.device_name, "MacBook Pro");
      assert.equal(parsedBody.platform, "macos");
    });

    it("throws descriptive error when pairing code is rejected or expired (401)", async () => {
      setRequestUrlHandler(async () => {
        return {
          status: 401,
          headers: {},
          text: JSON.stringify({ detail: "Invalid, expired, or burned pairing code" }),
          json: { detail: "Invalid, expired, or burned pairing code" },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      await assert.rejects(
        async () => {
          await pairDevice({
            baseUrl: "http://100.64.0.12:8765",
            code: "12345678",
          });
        },
        (err: any) => {
          return (
            err.message.includes("Code rejected") &&
            err.message.includes("invalid, expired, or already used")
          );
        }
      );
    });

    it("throws error on rate limit (429)", async () => {
      setRequestUrlHandler(async () => {
        return {
          status: 429,
          headers: {},
          text: JSON.stringify({ detail: "Too many pairing attempts" }),
          json: { detail: "Too many pairing attempts" },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      await assert.rejects(
        async () => {
          await pairDevice({
            baseUrl: "http://100.64.0.12:8765",
            code: "12345678",
          });
        },
        /Too many failed attempts/
      );
    });
  });

  describe("verifyHostAuthentication (F-17)", () => {
    it("returns ok and agents list on authenticated 200 response", async () => {
      let capturedAuth = "";
      setRequestUrlHandler(async (req) => {
        capturedAuth = req.headers?.["Authorization"] || "";
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            agents: [
              { id: "claude", name: "Claude Code", available: true },
              { id: "agy", name: "Antigravity", available: true },
            ],
          }),
          json: {
            agents: [
              { id: "claude", name: "Claude Code", available: true },
              { id: "agy", name: "Antigravity", available: true },
            ],
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      const res = await verifyHostAuthentication(
        "http://100.64.0.12:8765",
        "secret-token-xyz"
      );

      assert.equal(res.ok, true);
      assert.equal(capturedAuth, "Bearer secret-token-xyz");
      assert.equal(res.agents?.length, 2);
      assert.equal(res.agents?.[0].id, "claude");
    });

    it("never fakes connected when status is 401 token rejected", async () => {
      setRequestUrlHandler(async () => {
        return {
          status: 401,
          headers: {},
          text: "Unauthorized",
          json: { detail: "Device token revoked" },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      const res = await verifyHostAuthentication(
        "http://100.64.0.12:8765",
        "revoked-token"
      );

      assert.equal(res.ok, false);
      assert.match(res.error!, /Token rejected/);
    });

    it("handles connection failure gracefully", async () => {
      setRequestUrlHandler(async () => {
        throw new Error("Connection refused (ECONNREFUSED)");
      });

      const res = await verifyHostAuthentication(
        "http://100.64.0.12:8765",
        "tok"
      );

      assert.equal(res.ok, false);
      assert.match(res.error!, /ECONNREFUSED/);
    });
  });

  describe("requestPairCode (G-12)", () => {
    it("requests an 8-digit pairing code with bearer token", async () => {
      let capturedAuth = "";
      setRequestUrlHandler(async (req) => {
        capturedAuth = req.headers?.["Authorization"] || "";
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            code: "98765432",
            expires_in: 600,
            server_name: "ThinkPad Lab",
          }),
          json: {
            code: "98765432",
            expires_in: 600,
            server_name: "ThinkPad Lab",
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      const res = await requestPairCode("http://100.64.0.12:8765", "my-valid-bearer");
      assert.equal(res.code, "98765432");
      assert.equal(res.expires_in, 600);
      assert.equal(capturedAuth, "Bearer my-valid-bearer");
    });

    it("throws error on 401 unauthenticated request", async () => {
      setRequestUrlHandler(async () => {
        return {
          status: 401,
          headers: {},
          text: "Unauthorized",
          json: { detail: "Unauthorized" },
          arrayBuffer: new ArrayBuffer(0),
        };
      });

      await assert.rejects(
        async () => {
          await requestPairCode("http://100.64.0.12:8765", "bad-token");
        },
        /Unauthorized to generate pairing code/
      );
    });
  });
});
