# Wrapping a third-party MCP server with CasCet

Proof that CasCet monetizes **any** MCP server, not just first-party ones. This
config wraps the official reference server `@modelcontextprotocol/server-everything`
(npx, zero config) and sells three of its tools per call over x402 on Casper.

```bash
# 1. Point apiKey at your CSPR.cloud access token in cascet.config.json
# 2. Start the paid gateway:
npx cascet wrap examples/wrap-third-party/cascet.config.json

# 3. Discover its paid tools (Bazaar-compatible):
curl http://localhost:4410/.well-known/x402.json

# 4. Connect any MCP host and pay per call:
CASCET_KEY_PATH=./agent.pem npx cascet connect http://localhost:4410/mcp
```

The upstream server is unmodified — CasCet adds the paywall, receipts, on-chain
anchoring and discovery around it.
