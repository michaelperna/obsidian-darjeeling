# Direct Provider API Mode

Direct Provider API mode enables you to chat directly with leading AI models from inside Obsidian without running a companion daemon, installing Python, or setting up a server.

---

## 1. Supported Providers

| Provider | Endpoint | Recommended Models | Features |
|---|---|---|---|
| **Google Gemini** | `generativelanguage.googleapis.com` | `gemini-2.5-flash`, `gemini-1.5-pro` | Large context window, fast responses. |
| **Anthropic Claude** | `api.anthropic.com` | `claude-3-7-sonnet`, `claude-3-5-haiku` | Nuanced reasoning, markdown synthesis. |
| **DeepSeek** | `api.deepseek.com` | `deepseek-chat`, `deepseek-reasoner` | Math, code generation, chain-of-thought extraction. |
| **Ollama** | Local or remote (`localhost:11434`) | `llama3.2`, `mistral`, `qwen2.5-coder` | Fully private, offline, open-weights. |
| **OpenAI-Compatible** | Custom URL (OpenAI, OpenRouter, Groq) | Any chat completions model | Universal compatibility with self-hosted LLMs. |

---

## 2. Platform Support & Mobile Capabilities

- **Zero-Server Setup**: Runs entirely within Obsidian on **macOS, Linux, Windows, iOS, iPadOS, and Android**.
- **CORS Bypass**: Calls use Obsidian's native `requestUrl` runtime, allowing direct connections to provider APIs without requiring local proxy daemons or browser extensions.

---

## 3. Operational Trade-Offs

When comparing Direct API mode to the Companion Server or Local CLI:
1. **No Shell or CLI Tools**: Direct API mode does not have access to an operating system shell, file modification tools, or code compilers. It operates as a knowledge assistant, synthesizer, and drafting tool.
2. **Buffered Mobile Responses**: Due to mobile networking constraints and `requestUrl` semantics, responses on mobile devices are buffered and rendered in full upon completion rather than streamed token-by-token.
3. **Context Injection**: You can attach the active note or expand `[[note links]]` in your prompt. Darjeeling truncates linked note content at 32 KB per note with a visible marker to protect your token budget.

---

## 4. Key Storage & Privacy

- **Device-Local Storage**: API keys are saved exclusively on the local device in Obsidian's private data storage or `SecretStorage`.
- **Zero Cloud Proxying**: Your prompt and API keys travel directly from your device to the configured provider endpoint over TLS. No intermediate server or third-party proxy ever touches your keys.

---

## 5. Billing & Costs

- All usage is billed directly to your account with each respective AI provider (Google Cloud, Anthropic, DeepSeek, OpenRouter, etc.).
- Project Darjeeling is completely free, open-source software with no platform fees, token markups, or subscription tiers.
