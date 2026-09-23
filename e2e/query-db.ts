import { Database } from "bun:sqlite";

// One read-only query against a library's database, printed as JSON. e2e/support.ts runs this with
// Bun because Playwright runs on Node, which can't open bun:sqlite.
// Usage: bun e2e/query-db.ts <openfield.db> <sql> [json params]

const [file, sql, params = "[]"] = process.argv.slice(2);
if (!file || !sql) throw new Error("Usage: bun e2e/query-db.ts <openfield.db> <sql> [json params]");
const db = new Database(file, { readonly: true });
process.stdout.write(JSON.stringify(db.query(sql).all(...JSON.parse(params))));
db.close();
