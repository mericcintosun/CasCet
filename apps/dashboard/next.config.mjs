/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@cascet/core"],
  serverExternalPackages: ["casper-js-sdk"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
