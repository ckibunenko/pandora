import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const REPO_ROOT = "../..";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, REPO_ROOT, "");
  const apiPort = env["API_PORT"];
  if (command === "serve" && !apiPort) {
    throw new Error("API_PORT is not set. Copy .env.example to .env in the repository root.");
  }

  return {
    envDir: REPO_ROOT,
    plugins: [react()],
    server: {
      proxy: apiPort ? { "/api": `http://localhost:${apiPort}` } : {},
    },
  };
});
