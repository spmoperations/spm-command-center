// Checks the database the app is set to use, and brings its schema up to date.
//   npm run db:check
// Prints where the data lives (never the password), which migrations are applied, and
// whether every table is locked against the hosted database's public API.
import { databaseHome, describeDbError, getDb } from "@/server/db";

async function main() {
  console.log(`Database: ${databaseHome()}`);
  const db = await getDb();
  const migrations = await db.query<{ name: string }>("select name from schema_migrations order by name");
  console.log(`Schema: ${migrations.map((m) => m.name).join(", ")}`);
  const tables = await db.query<{ name: string; locked: boolean }>(
    "select relname as name, relrowsecurity as locked from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname",
  );
  const open = tables.filter((t) => !t.locked).map((t) => t.name);
  console.log(`Tables: ${tables.length}`);
  console.log(open.length ? `NOT LOCKED (readable through the public API): ${open.join(", ")}` : "Every table is locked against the public API.");
  const [counts] = await db.query<Record<string, number>>(
    "select (select count(*) from conversations)::int as conversations, (select count(*) from messages)::int as messages, (select count(*) from meetings)::int as meetings, (select count(*) from tasks)::int as tasks",
  );
  console.log(`Rows: ${Object.entries(counts).map(([name, n]) => `${n} ${name}`).join(", ")}`);
  await db.close();
  if (open.length) process.exit(1);
}

main().catch((error) => {
  console.error(describeDbError(error));
  process.exit(1);
});
