import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, eq, gt } from 'drizzle-orm';
import * as schema from './schema.js';

export interface PullParams {
  agentId: string;
  lastPulledAt?: number | null;
  limit?: number;
}

interface SyncCheckInPayload {
  id: string;
  mission_id: string;
  check_in_time: number;
  check_out_time?: number;
  check_in_lat: number;
  check_in_lng: number;
  check_in_method: string;
}

interface SyncMissionPayload {
  id: string;
  site_id: string | null;
  title: string;
}

interface SyncSitePayload {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface PullResult {
  changes: {
    check_ins: {
      created: SyncCheckInPayload[];
      updated: SyncCheckInPayload[];
      deleted: string[];
    };

    sites: {
      created: SyncSitePayload[];
      updated: SyncSitePayload[];
      deleted: string[];
    };

    missions: {
      created: SyncMissionPayload[];
      updated: SyncMissionPayload[];
      deleted: string[];
    };
  };

  timestamp: number;
  has_more: boolean;
}

export class SyncPullService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.db = db;
  }

  async pullChanges({
    agentId,
    lastPulledAt = null,
    limit = 500,
  }: PullParams): Promise<PullResult> {
    const safeLimit = Math.min(Math.max(limit, 1), 5_000);
    const sinceSeq = lastPulledAt ?? 0;

    const records = await this.db
      .select()
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.agentId, agentId),
          gt(schema.checkIns.syncSeq, sinceSeq),
        ),
      )
      .orderBy(asc(schema.checkIns.syncSeq))
      .limit(safeLimit + 1);

    const hasMore = records.length > safeLimit;
    const sliced = records.slice(0, safeLimit);

    const created: SyncCheckInPayload[] = [];
    const updated: SyncCheckInPayload[] = [];
    const deleted: string[] = [];

    for (const record of sliced) {
      if (record.deletedAt !== null) {
        deleted.push(record.id);
      } else if (
        record.createdAt === record.updatedAt ||
        record.syncSeq === record.createdAt
      ) {
        created.push(this.mapCheckIn(record));
      } else {
        updated.push(this.mapCheckIn(record));
      }
    }

    const timestamp =
      sliced.length > 0
        ? Number(sliced[sliced.length - 1].syncSeq)
        : sinceSeq;

    let missions: {
      created: SyncMissionPayload[];
      updated: SyncMissionPayload[];
      deleted: string[];
    } = {
      created: [],
      updated: [],
      deleted: [],
    };

    let sites: {
      created: SyncSitePayload[];
      updated: SyncSitePayload[];
      deleted: string[];
    } = {
      created: [],
      updated: [],
      deleted: [],
    };

    /*
     * Premier pull uniquement :
     * récupération des missions appartenant à l'agent
     * et des sites associés.
     */
    if (sinceSeq === 0) {
      const missionRows = await this.db
        .select()
        .from(schema.missions)
        .where(eq(schema.missions.agentId, agentId));

      for (const mission of missionRows) {
        if (mission.deletedAt !== null) {
          missions.deleted.push(mission.id);
        } else {
          missions.created.push({
            id: mission.id,
            site_id: mission.siteId,
            title: mission.title,
          });
        }
      }

      const siteIds = Array.from(
        new Set(
          missionRows
            .map((mission) => mission.siteId)
            .filter(
              (value): value is string =>
                value !== null && value !== undefined,
            ),
        ),
      );

      if (siteIds.length > 0) {
        const siteRows = await this.db
          .select()
          .from(schema.sites);

        for (const site of siteRows) {
          if (!siteIds.includes(site.id)) {
            continue;
          }

          if (site.deletedAt !== null) {
            sites.deleted.push(site.id);
          } else {
            sites.created.push({
              id: site.id,
              name: site.name,
              latitude: Number(site.latitude),
              longitude: Number(site.longitude),
            });
          }
        }
      }
    }

    return {
      changes: {
        check_ins: {
          created,
          updated,
          deleted,
        },
        sites,
        missions,
      },
      timestamp,
      has_more: hasMore,
    };
  }

  private mapCheckIn(
    record: schema.CheckIn,
  ): SyncCheckInPayload {
    return {
      id: record.id,
      mission_id: record.missionId,
      check_in_time: record.checkInTime,

      ...(record.checkOutTime !== null &&
      record.checkOutTime !== undefined
        ? {
            check_out_time: record.checkOutTime,
          }
        : {}),

      check_in_lat: record.checkInLat,
      check_in_lng: record.checkInLng,
      check_in_method: record.checkInMethod,
    };
  }
}