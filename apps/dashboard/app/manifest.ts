import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CasCet · Payments that cascade",
    short_name: "CasCet",
    description:
      "The monetization layer for MCP on Casper: per-tool x402 micropayments with composable, budget-bounded cascading payments settled on-chain.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0d12",
    theme_color: "#0b0d12",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon.png", type: "image/png", sizes: "180x180" },
    ],
  };
}
