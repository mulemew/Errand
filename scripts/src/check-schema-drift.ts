/**
 * Does the SQL the server runs at startup create the schema the code expects?
 *
 * There are two descriptions of the database and both are written by hand:
 *
 *   lib/db/src/schema/*.ts              what the code reads and writes
 *   api-server/src/lib/migrations.ts    the DDL that runs on every boot
 *
 * Adding a column means editing both. Forgetting the second compiles, typechecks, passes
 * review, and fails at runtime on the first query — as a Postgres error naming a column
 * nobody can find, on whichever page happens to touch it first.
 *
 * So this compares them, as text, with no database and no dependencies: both sides are
 * source files in a consistent shape. It asks one question — is there anything the code
 * expects that the migration never creates — because that is the direction that breaks.
 * DDL creating something unused is harmless and not reported.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const SCHEMA_DIR = path.join(ROOT, "lib/db/src/schema");
const MIGRATIONS = path.join(ROOT, "artifacts/api-server/src/lib/migrations.ts");

/** Tables and columns the DDL creates: CREATE TABLE bodies plus ALTER … ADD COLUMN. */
function fromDdl(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const add = (t: string, c: string) => {
    const key = t.toLowerCase();
    if (!tables.has(key)) tables.set(key, new Set());
    tables.get(key)!.add(c.toLowerCase());
  };

  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\);/gi;
  for (let m = create.exec(sql); m; m = create.exec(sql)) {
    const [, table, body] = m;
    for (const line of body.split("\n")) {
      // A column line starts with a quoted identifier; PRIMARY KEY (…) and UNIQUE (…) do not.
      const col = /^\s*"(\w+)"\s+\S/.exec(line);
      if (col) add(table, col[1]);
    }
  }

  const alter = /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
  for (let m = alter.exec(sql); m; m = alter.exec(sql)) add(m[1], m[2]);

  return tables;
}

/**
 * Tables and columns the Drizzle schema declares.
 *
 * `pgTable("tasks", { … })` names the table; inside it every column is a call whose first
 * string argument is the SQL name — `text("origin_url")`, `boolean("autostart")`. That is
 * the name the query will use, which is the one that has to exist.
 */
function fromSchema(src: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  // The name may sit on the same line or the next one, and the body may be followed by an
  // index callback — logs and browser_sessions are declared both ways. A parser that saw
  // only one shape skipped those tables SILENTLY, which is the one failure mode a drift
  // check must not have: it reports "ok" while checking nothing.
  const table = /pgTable\(\s*"(\w+)"\s*,\s*\{([\s\S]*?)\n\s*\}/g;
  for (let m = table.exec(src); m; m = table.exec(src)) {
    const [, name, body] = m;
    const cols = new Set<string>();
    // property: type("sql_name"…) — the property name is the JS side, the string is SQL.
    const col = /^\s*\w+\s*:\s*\w+\(\s*"(\w+)"/gm;
    for (let c = col.exec(body); c; c = col.exec(body)) cols.add(c[1].toLowerCase());
    tables.set(name.toLowerCase(), cols);
  }
  return tables;
}

const ddl = fromDdl(fs.readFileSync(MIGRATIONS, "utf8"));

const declared = new Map<string, Set<string>>();
for (const file of fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts"))) {
  for (const [t, cols] of fromSchema(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf8"))) {
    declared.set(t, cols);
  }
}

if (declared.size === 0) {
  console.error(`check-schema-drift: parsed no tables out of ${SCHEMA_DIR} — the check itself is broken.`);
  process.exit(2);
}

// Count the declarations directly and insist the parser found all of them. Without this a
// table shape the regex cannot read is skipped in silence, and the check reports "ok" while
// ignoring exactly the table someone just added.
const declaredCount = fs
  .readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".ts"))
  .reduce((n, f) => n + (fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8").match(/pgTable\(/g)?.length ?? 0), 0);
if (declared.size !== declaredCount) {
  console.error(
    `check-schema-drift: found ${declaredCount} pgTable declarations but parsed only ${declared.size}. ` +
      `A table is being skipped — fix the parser rather than trusting this result.`,
  );
  process.exit(2);
}

const missing: string[] = [];
let columns = 0;
for (const [table, cols] of declared) {
  const created = ddl.get(table);
  if (!created) {
    missing.push(`table "${table}" is declared in the schema but no migration creates it`);
    continue;
  }
  for (const c of cols) {
    columns++;
    if (!created.has(c)) missing.push(`"${table}"."${c}" is in the schema but no migration creates it`);
  }
}

if (missing.length) {
  console.error(`check-schema-drift: ${missing.length} thing(s) the startup migration does not create:\n`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error(`\nAdd them to ${path.relative(ROOT, MIGRATIONS)}.`);
  process.exit(1);
}

console.log(`check-schema-drift: ok — ${declared.size} tables, ${columns} columns, all created by the migration.`);
