/**
 * Baseline security headers on every response (L34). Deliberately NOT a full
 * Content-Security-Policy: a script/style policy would break Next.js inline
 * runtime scripts without nonces. `frame-ancestors 'none'` is the only CSP
 * directive set; it does not restrict scripts or styles.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@cascet/core"],
  serverExternalPackages: ["casper-js-sdk"],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
