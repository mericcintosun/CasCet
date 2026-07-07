/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@cascet/core"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
