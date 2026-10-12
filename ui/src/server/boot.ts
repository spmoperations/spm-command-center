// What every request needs first: the database opened and migrated, and the owner set up.
import { connectFromEnv } from "./connections";
import { describeDbError, getDb, type Db } from "./db";
import { ensureOwner, OWNER_ID } from "./repo";

const holder = globalThis as unknown as { __commandCenterReady?: Promise<Db> };

export function ready(): Promise<Db> {
  if (!holder.__commandCenterReady) {
    const starting = (async () => {
      try {
        const db = await getDb();
        await ensureOwner(db);
        for (const note of await connectFromEnv(db, OWNER_ID)) console.log(`[command-center] ${note}`);
        return db;
      } catch (error) {
        // The screens show this, so it says what to do and leaves the address out.
        throw new Error(describeDbError(error), { cause: error });
      }
    })();
    // A failed start is not kept: the next request tries again.
    starting.catch((error: Error) => {
      console.error(`[command-center] ${error.message}`);
      if (holder.__commandCenterReady === starting) holder.__commandCenterReady = undefined;
    });
    holder.__commandCenterReady = starting;
  }
  return holder.__commandCenterReady;
}
