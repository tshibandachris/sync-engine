import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres } from './helpers/testcontainers-pg.js';

describe('DEBUG incremental sync', () => {
  it('diagnostique les triggers et sync_seq', async () => {
    const pg = await startTestPostgres();

    try {
      const pool = pg.pool;

      const agentId = randomUUID();
      const siteId = randomUUID();
      const missionId = randomUUID();

      await pool.query(
        'TRUNCATE check_ins, missions, sites, sync_idempotency_keys RESTART IDENTITY CASCADE',
      );

      await pool.query(
        'ALTER SEQUENCE global_sync_seq RESTART WITH 1',
      );

      console.log('');
      console.log('================================================');
      console.log(' DEBUG SYNC SEQ');
      console.log('================================================');

      // --------------------------------------------------------
      // TRIGGERS
      // --------------------------------------------------------

      const triggers = await pool.query(`
        SELECT
          c.relname AS table_name,
          t.tgname AS trigger_name,
          pg_get_triggerdef(t.oid) AS trigger_definition
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname IN ('missions', 'sites', 'check_ins')
          AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname
      `);

      console.log('');
      console.log('--- TRIGGERS ---');
      console.table(triggers.rows);

      // --------------------------------------------------------
      // INSERT SITE
      // --------------------------------------------------------

      await pool.query(
        `
        INSERT INTO sites
          (id, name, latitude, longitude)
        VALUES ($1, $2, $3, $4)
        `,
        [siteId, 'Debug Site', 48.85, 2.35],
      );

      const siteAfterInsert = await pool.query(
        `
        SELECT
          id,
          name,
          sync_seq,
          first_sync_seq,
          created_at,
          updated_at,
          deleted_at
        FROM sites
        WHERE id = $1
        `,
        [siteId],
      );

      console.log('');
      console.log('--- SITE APRES INSERT ---');
      console.table(siteAfterInsert.rows);

      // --------------------------------------------------------
      // INSERT MISSION
      // --------------------------------------------------------

      await pool.query(
        `
        INSERT INTO missions
          (id, agent_id, title, site_id)
        VALUES ($1, $2, $3, $4)
        `,
        [missionId, agentId, 'Debug Mission', siteId],
      );

      const missionAfterInsert = await pool.query(
        `
        SELECT
          id,
          agent_id,
          title,
          site_id,
          sync_seq,
          first_sync_seq,
          created_at,
          updated_at,
          deleted_at
        FROM missions
        WHERE id = $1
        `,
        [missionId],
      );

      console.log('');
      console.log('--- MISSION APRES INSERT ---');
      console.table(missionAfterInsert.rows);

      // --------------------------------------------------------
      // SEQUENCE APRES INSERT
      // --------------------------------------------------------

      const seqAfterInsert = await pool.query(
        `SELECT last_value FROM global_sync_seq`,
      );

      console.log('');
      console.log('--- SEQUENCE APRES INSERTS ---');
      console.table(seqAfterInsert.rows);

      // --------------------------------------------------------
      // UPDATE MISSION
      // --------------------------------------------------------

      await pool.query(
        `
        UPDATE missions
        SET title = 'Debug Mission Modifiee'
        WHERE id = $1
        `,
        [missionId],
      );

      const missionAfterUpdate = await pool.query(
        `
        SELECT
          id,
          title,
          sync_seq,
          first_sync_seq,
          created_at,
          updated_at
        FROM missions
        WHERE id = $1
        `,
        [missionId],
      );

      console.log('');
      console.log('--- MISSION APRES UPDATE ---');
      console.table(missionAfterUpdate.rows);

      // --------------------------------------------------------
      // UPDATE SITE
      // --------------------------------------------------------

      await pool.query(
        `
        UPDATE sites
        SET name = 'Debug Site Modifie'
        WHERE id = $1
        `,
        [siteId],
      );

      const siteAfterUpdate = await pool.query(
        `
        SELECT
          id,
          name,
          sync_seq,
          first_sync_seq,
          created_at,
          updated_at
        FROM sites
        WHERE id = $1
        `,
        [siteId],
      );

      console.log('');
      console.log('--- SITE APRES UPDATE ---');
      console.table(siteAfterUpdate.rows);

      // --------------------------------------------------------
      // SEQUENCE FINALE
      // --------------------------------------------------------

      const seqFinal = await pool.query(
        `SELECT last_value FROM global_sync_seq`,
      );

      console.log('');
      console.log('--- SEQUENCE FINALE ---');
      console.table(seqFinal.rows);

      // --------------------------------------------------------
      // VERIFICATIONS
      // --------------------------------------------------------

      expect(siteAfterInsert.rows[0].sync_seq)
        .toBeDefined();

      expect(missionAfterInsert.rows[0].sync_seq)
        .toBeDefined();

      expect(Number(missionAfterUpdate.rows[0].sync_seq))
        .toBeGreaterThan(Number(missionAfterInsert.rows[0].sync_seq));

      expect(Number(siteAfterUpdate.rows[0].sync_seq))
        .toBeGreaterThan(Number(siteAfterInsert.rows[0].sync_seq));

      expect(Number(missionAfterUpdate.rows[0].first_sync_seq))
        .toBe(Number(missionAfterInsert.rows[0].first_sync_seq));

      expect(Number(siteAfterUpdate.rows[0].first_sync_seq))
        .toBe(Number(siteAfterInsert.rows[0].first_sync_seq));

    } finally {
      await pg.stop();
    }
  });
});
