// A real PostgreSQL for tests: PGlite (Postgres compiled to WebAssembly) behind a local socket, with the app's
// migrations applied. Prisma connects to it like to any Postgres server, so SQL, transactions and row locks
// are tested for real, without installing a database.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export async function startDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = await PGlite.create();
  const dir = path.resolve("prisma/migrations");
  for (const m of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
  }
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable&connection_limit=1&pool_timeout=60`;
  // Uploaded files and reports go to a temporary folder
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uploader-test-"));
  return {
    db,
    storageDir: process.env.STORAGE_DIR,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
