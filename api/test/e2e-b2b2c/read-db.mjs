// Prints the stored db (DATA_DIR + STORE + DATABASE_URL + PG_SCHEMA_FROM_DATA_DIR from the environment) as JSON.
import { readDb } from '../helpers/read-db.js';
process.stdout.write(JSON.stringify(await readDb(process.env.DATA_DIR)));
