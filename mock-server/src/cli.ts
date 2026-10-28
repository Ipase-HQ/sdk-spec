#!/usr/bin/env node
// Entrypoint: PORT (default 8787), HOST (default 0.0.0.0), SCHEMA_PATH (default ../schema/batch.schema.json),
// FIXTURES_DIR (default ../fixtures, read by POST /__verify).
import { createMockServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const log = (line: string) => console.log(`[mock-server] ${line}`);

const server = createMockServer({ schemaPath: process.env.SCHEMA_PATH, fixturesDir: process.env.FIXTURES_DIR, log });
server.listen(port, host, () => log(`listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
