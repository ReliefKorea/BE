import fs from 'fs/promises';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import loadEnv from '../../loadEnv.js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');
const configuredDbPath = process.env.DB_PATH || process.env.DATABASE_PATH;
const dbPath = configuredDbPath
  ? path.resolve(backendRoot, configuredDbPath)
  : path.join(backendRoot, 'data', 'disaster.sqlite');
const schemaPath = path.join(backendRoot, 'db', 'schema.sql');

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

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

function stableSlug(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_]+/g, '_');
}

function booleanFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;

  const normalized = String(raw).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

async function countRows(db, tableName) {
  const row = await get(db, `SELECT COUNT(*) AS count FROM ${tableName}`);
  return Number(row?.count ?? 0);
}

async function firstEventIds(db) {
  const typhoon = await get(db, `
    SELECT seq, tmFc
    FROM typhoon_data
    WHERE seq IS NOT NULL AND tmFc IS NOT NULL
    ORDER BY tmFc DESC, seq DESC
    LIMIT 1
  `);
  const earthquake = await get(db, `
    SELECT id
    FROM earthquake_data
    ORDER BY tmEqk DESC, id DESC
    LIMIT 1
  `);
  const wildfire = await get(db, `
    SELECT id
    FROM wildfire_data
    ORDER BY CAST(startyear AS INTEGER) DESC,
             CAST(startmonth AS INTEGER) DESC,
             CAST(startday AS INTEGER) DESC,
             id DESC
    LIMIT 1
  `);

  return {
    typhoon: typhoon ? `typhoon_${typhoon.seq}_${typhoon.tmFc}` : 'typhoon_seed_1',
    earthquake: earthquake ? `earthquake_${earthquake.id}` : 'earthquake_seed_1',
    wildfire: wildfire ? `wildfire_${wildfire.id}` : 'wildfire_seed_1'
  };
}

function buildSeeds(eventIds) {
  const typhoonOrgId = `org_redcross_${stableSlug(eventIds.typhoon)}`;
  const earthquakeOrgId = `org_relief_${stableSlug(eventIds.earthquake)}`;
  const wildfireOrgId = `org_forest_${stableSlug(eventIds.wildfire)}`;

  return {
    officialUpdates: [
      {
        update_id: `upd_${stableSlug(eventIds.typhoon)}_1`,
        event_id: eventIds.typhoon,
        source_name: 'Korea Meteorological Administration',
        source_type: 'typhoon advisory',
        issued_at: '2026-05-20T00:00:00.000Z',
        title: 'Typhoon monitoring update',
        summary: 'Seed advisory for validating the official updates API.',
        original_link: 'https://www.weather.go.kr'
      },
      {
        update_id: `upd_${stableSlug(eventIds.earthquake)}_1`,
        event_id: eventIds.earthquake,
        source_name: 'Korea Meteorological Administration',
        source_type: 'earthquake report',
        issued_at: '2026-05-20T00:00:00.000Z',
        title: 'Earthquake report confirmed',
        summary: 'Seed report for validating earthquake detail data.',
        original_link: 'https://www.weather.go.kr'
      },
      {
        update_id: `upd_${stableSlug(eventIds.wildfire)}_1`,
        event_id: eventIds.wildfire,
        source_name: 'Korea Forest Service',
        source_type: 'wildfire statistics',
        issued_at: '2026-05-20T00:00:00.000Z',
        title: 'Wildfire record confirmed',
        summary: 'Seed report for validating wildfire detail data.',
        original_link: 'https://www.forest.go.kr'
      }
    ],
    organizationActions: [
      {
        org_id: typhoonOrgId,
        event_id: eventIds.typhoon,
        org_name: 'Korean Red Cross',
        activity_region: 'Typhoon impact area',
        activity_type: 'Emergency relief preparation',
        activity_summary: 'Preparing shelters and emergency supplies for potential typhoon impact.',
        ai_message: 'Prioritize shelter, water, and basic supplies for vulnerable households.',
        donation_link: 'https://www.redcross.or.kr',
        volunteer_link: 'https://www.redcross.or.kr/volunteer',
        evidence_note: 'Seed organization action for API validation.',
        verified_by_admin: 1,
        last_checked_at: '2026-05-20T00:00:00.000Z'
      },
      {
        org_id: earthquakeOrgId,
        event_id: eventIds.earthquake,
        org_name: 'Disaster Relief Association',
        activity_region: 'Earthquake affected area',
        activity_type: 'Temporary shelter support',
        activity_summary: 'Preparing temporary shelter guidance and basic relief kits.',
        ai_message: 'Safety checks and temporary shelter information should be reviewed first.',
        donation_link: 'https://www.relief.or.kr',
        volunteer_link: '',
        evidence_note: 'Seed organization action for API validation.',
        verified_by_admin: 1,
        last_checked_at: '2026-05-20T00:00:00.000Z'
      },
      {
        org_id: wildfireOrgId,
        event_id: eventIds.wildfire,
        org_name: 'Forest Disaster Support Center',
        activity_region: 'Wildfire affected area',
        activity_type: 'Recovery support',
        activity_summary: 'Preparing recovery supplies and resource coordination after wildfire damage.',
        ai_message: 'Recovery support should continue after containment, especially for damaged homes.',
        donation_link: '',
        volunteer_link: 'https://www.forest.go.kr',
        evidence_note: 'Seed organization action for API validation.',
        verified_by_admin: 1,
        last_checked_at: '2026-05-20T00:00:00.000Z'
      }
    ],
    donationRecords: [
      {
        record_id: `rec_${stableSlug(typhoonOrgId)}_1`,
        org_id: typhoonOrgId,
        date: '2026-05-20',
        title: 'Emergency relief kits prepared',
        amount: 'KRW 2,000,000',
        beneficiaries: 300,
        region: 'Typhoon impact area',
        description: 'Prepared water, blankets, hygiene kits, and basic supplies.',
        disaster_type: 'typhoon'
      },
      {
        record_id: `rec_${stableSlug(earthquakeOrgId)}_1`,
        org_id: earthquakeOrgId,
        date: '2026-05-20',
        title: 'Temporary shelter supplies prepared',
        amount: 'KRW 1,500,000',
        beneficiaries: 180,
        region: 'Earthquake affected area',
        description: 'Prepared basic supplies for temporary shelter operations.',
        disaster_type: 'earthquake'
      },
      {
        record_id: `rec_${stableSlug(wildfireOrgId)}_1`,
        org_id: wildfireOrgId,
        date: '2026-05-20',
        title: 'Wildfire recovery supplies prepared',
        amount: 'KRW 1,300,000',
        beneficiaries: 150,
        region: 'Wildfire affected area',
        description: 'Prepared supplies for household recovery after wildfire damage.',
        disaster_type: 'wildfire'
      }
    ]
  };
}

async function seedDb() {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const db = new sqlite3.Database(dbPath);

  try {
    await exec(db, schemaSql);
    const seeds = buildSeeds(await firstEventIds(db));
    const seedDemoSupportData = booleanFromEnv('SEED_DEMO_SUPPORT_DATA', false);

    if (await countRows(db, 'official_updates') === 0) {
      for (const update of seeds.officialUpdates) {
        await run(db, `
          INSERT OR IGNORE INTO official_updates (
            update_id, event_id, source_name, source_type, issued_at, title, summary, original_link
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          update.update_id,
          update.event_id,
          update.source_name,
          update.source_type,
          update.issued_at,
          update.title,
          update.summary,
          update.original_link
        ]);
      }
    }

    if (seedDemoSupportData && await countRows(db, 'organization_actions') === 0) {
      for (const org of seeds.organizationActions) {
        await run(db, `
          INSERT OR IGNORE INTO organization_actions (
            org_id, event_id, org_name, activity_region, activity_type, activity_summary,
            ai_message, donation_link, volunteer_link, evidence_note, verified_by_admin, last_checked_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          org.org_id,
          org.event_id,
          org.org_name,
          org.activity_region,
          org.activity_type,
          org.activity_summary,
          org.ai_message,
          org.donation_link,
          org.volunteer_link,
          org.evidence_note,
          org.verified_by_admin,
          org.last_checked_at
        ]);
      }
    }

    if (seedDemoSupportData && await countRows(db, 'donation_records') === 0) {
      for (const record of seeds.donationRecords) {
        await run(db, `
          INSERT OR IGNORE INTO donation_records (
            record_id, org_id, date, title, amount, beneficiaries, region, description, disaster_type
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          record.record_id,
          record.org_id,
          record.date,
          record.title,
          record.amount,
          record.beneficiaries,
          record.region,
          record.description,
          record.disaster_type
        ]);
      }
    }

    console.log(`Database seeded: ${dbPath}`);
  } finally {
    await closeDatabase(db);
  }
}

seedDb().catch(error => {
  console.error(`Database seeding failed: ${error.message}`);
  process.exitCode = 1;
});
