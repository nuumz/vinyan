import { createUser } from "./app.ts";
import type { Config } from "./types.ts";

const defaultConfig: Config = {
  port: 3000,
  debug: false,
  database: "sqlite://local.db",
};

export function startServer(config: Config = defaultConfig): void {
  const admin = createUser(1, "admin", "admin@example.com");
  console.log(`Server starting on port ${config.port}`, admin);
}
