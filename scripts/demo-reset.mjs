import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = process.env.DEMO_COMPOSE_PROJECT ?? "pandora-demo";
if (!/^pandora-demo(?:-qa-[a-z0-9-]+)?$/.test(project)) {
  throw new Error("Only the dedicated demo project or a demo QA project may be reset.");
}
if (!/^[A-Za-z0-9_-]{12,128}$/.test(process.env.DEMO_DB_PASSWORD ?? "")) {
  throw new Error("DEMO_DB_PASSWORD must contain 12–128 URL-safe letters, digits, underscores, or hyphens.");
}
if ((process.env.DEMO_USER_PASSWORD?.length ?? 0) < 12 || (process.env.DEMO_USER_PASSWORD?.length ?? 0) > 256) {
  throw new Error("DEMO_USER_PASSWORD must contain 12–256 characters.");
}

function compose(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "--env-file", ".env.demo", "-f", "compose.demo.yml", "-p", project, ...args], {
      cwd: root, env: process.env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`Demo operation ${args[0]} failed.`)));
  });
}

const control = (...args) => compose(["run", "--rm", "--no-deps", "web", ...args]);
let locked = false;
try {
  // The volume lock coordinates different shells/checkouts against the same Docker project.
  // A killed operator leaves this lock and the maintenance marker for explicit recovery.
  await control("mkdir", "/maintenance/reset-lock");
  locked = true;
  await control("touch", "/maintenance/enabled");
  console.log("Maintenance enabled. Stopping demo writers.");
  await compose(["stop", "--timeout", "30", "api"]);
  if (await compose(["ps", "--status", "running", "-q", "api"], true)) {
    throw new Error("The demo API is still running; refusing to restore data.");
  }
  await compose(["up", "-d", "--wait", "--wait-timeout", "60", "postgres", "web"]);
  await compose(["run", "--rm", "--no-deps", "reset", "node", "node_modules/prisma/build/index.js", "migrate", "deploy"]);
  await compose(["run", "--rm", "--no-deps", "reset"]);
  await compose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", "60", "api"]);
  await control("rm", "/maintenance/enabled");
  console.log(`Demo restored: http://localhost:${process.env.DEMO_PORT ?? "5180"}. Sign in again.`);
} catch (error) {
  if (locked) {
    // Covers errors after API startup too: an unhealthy or partly started stack must stay closed.
    await control("touch", "/maintenance/enabled").catch(() => {});
    await compose(["stop", "--timeout", "30", "api"]).catch(() => {});
    console.error("Reset failed; maintenance remains enabled. Fix the cause and retry demo:reset.");
  } else {
    console.error("Could not acquire the demo reset lock. Check Docker/images or an existing reset; see the recovery runbook.");
  }
  console.error(error instanceof Error ? error.message : "Demo reset failed.");
  process.exitCode = 1;
} finally {
  if (locked) await control("rmdir", "/maintenance/reset-lock").catch(() => { process.exitCode = 1; });
}
