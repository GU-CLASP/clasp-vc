import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function normalizeBasePath(value) {
  if (!value) return "/";
  let base = value.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return base;
}

function parseAllowedHosts(value) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "all") return "all";
  const hosts = trimmed
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return hosts.length ? hosts : undefined;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = normalizeBasePath(env.VITE_BASE_PATH || "/");
  const allowedHosts = parseAllowedHosts(env.VITE_ALLOWED_HOSTS);

  return {
    base,
    plugins: [react()],
    server: {
      ...(allowedHosts ? { allowedHosts } : {}),
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:9000",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
