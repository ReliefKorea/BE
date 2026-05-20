import fs from 'fs/promises';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import loadEnv from '../../loadEnv.js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(backendRoot, process.env.DATABASE_PATH)
  : path.join(backendRoot, 'data', 'disaster.sqlite');
const schemaPath = path.join(backendRoot, 'db', 'schema.sql');

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function initDb() {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const db = new sqlite3.Database(dbPath);

  try {
    await exec(db, schemaSql);
    console.log(`Database initialized: ${dbPath}`);
  } finally {
    await closeDatabase(db);
  }
}

initDb().catch(error => {
  console.error(`Database initialization failed: ${error.message}`);
  process.exitCode = 1;
});
