// Creates disposable databases on the DATABASE_URL server for checks and Bug Lab runs. Never drops anything.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const apiDir = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const SAFE_NAME = /^pandora_[a-z0-9_]+$/;
const DEFECT = /^BUG-[0-9]{3}$/;

/** Connects to the server behind `databaseUrl` using the API's Prisma client (the API must be built). */
export async function openServer(databaseUrl) {
  const serverUrl = new URL(databaseUrl);
  const developmentDatabase = serverUrl.pathname.slice(1);
  const requireFromApi = createRequire(join(apiDir, "package.json"));
  const { PrismaPg } = await import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href);
  const { PrismaClient } = await import(pathToFileURL(join(apiDir, "dist/generated/prisma/client.js")).href);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: serverUrl.toString() }) });

  function assertSafe(name) {
    if (!SAFE_NAME.test(name) || name === developmentDatabase || name === "pandora_demo") {
      throw new Error(`Refusing to use database "${name}".`);
    }
  }
  const urlFor = (name) => {
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };

  return {
    urlFor,
    /** Creates an empty database and returns its connection URL. */
    async create(name) {
      assertSafe(name);
      // Names are validated above; identifiers cannot be bound as query parameters.
      await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      return urlFor(name);
    },
    /** Marks a Bug Lab database for one defect; new connections see it as current_setting('pandora.defect'). */
    async markDefect(name, defect) {
      assertSafe(name);
      if (!DEFECT.test(defect)) throw new Error(`Refusing defect marker "${defect}".`);
      await client.$executeRawUnsafe(`ALTER DATABASE "${name}" SET pandora.defect = '${defect}'`);
    },
    close: () => client.$disconnect(),
  };
}
