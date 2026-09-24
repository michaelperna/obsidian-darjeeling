import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "styles.css", "node_modules/**", "dist/**", "_lab/**", "server/**", "tests/**", "scripts/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*", "esbuild.config.*"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: [
            "Darjeeling",
            "DeepSeek",
            "OpenAI",
            "OpenRouter",
            "Ollama",
            "Gemini",
            "Claude",
            "Claude Code",
            "Anthropic",
            "Meshnet",
            "Tailscale",
            "WireGuard",
            "Obsidian",
            "Google Gemini",
            "Google",
            "GitHub",
            "Linux",
            "macOS",
            "Android",
            "iOS",
            "Windows",
            "Electron",
          ],
          acronyms: [
            "AI",
            "CLI",
            "UI",
            "API",
            "URL",
            "HTTP",
            "HTTPS",
            "WS",
            "WSS",
            "ID",
            "QR",
            "JSON",
            "REST",
            "LLM",
            "SSH",
            "LAN",
            "IP",
            "SVG",
            "RAM",
            "CPU",
            "CW",
          ],
        },
      ],
    },
  },
]);
