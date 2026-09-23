import { defineConfig } from "drizzle-kit";

// Run from packages/db: `bun run generate`, or `bun run generate --custom --name=<name>`.
export default defineConfig({ dialect: "sqlite", schema: "./src/schema/index.ts", out: "./migrations" });
