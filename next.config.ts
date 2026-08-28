import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish driver: keep it out of the bundler and require it at runtime.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default config;
