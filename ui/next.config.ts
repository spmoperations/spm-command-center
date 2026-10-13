import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The database schema is read from these files when the server starts. On a host they have
  // to be packed with the server, which only happens if they are named here.
  outputFileTracingIncludes: { "/*": ["./db/migrations/*.sql"] },
  // Telegram's library is loaded as it is, only when Telegram is used, rather than bundled.
  serverExternalPackages: ["teleproto"],
};

export default nextConfig;
