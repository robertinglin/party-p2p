const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function tagValue(tags, name) {
  const tag = Array.isArray(tags) ? tags.find((item) => Array.isArray(item) && item[0] === name) : undefined;
  return tag ? tag[1] : undefined;
}

function sqliteFile(storagePath) {
  return path.join(storagePath, "events.sqlite");
}

class SqliteRelayStorage {
  constructor(storagePath) {
    this.storagePath = storagePath;
    fs.mkdirSync(storagePath, { recursive: true });
    this.db = new DatabaseSync(sqliteFile(storagePath));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS party_events (
        id TEXT PRIMARY KEY,
        party_id TEXT NOT NULL,
        kind INTEGER NOT NULL,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_party_events_party_created
      ON party_events (party_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_party_events_received
      ON party_events (received_at);
    `);
    this.insertStatement = this.db.prepare(`
      INSERT OR IGNORE INTO party_events
        (id, party_id, kind, pubkey, created_at, received_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteStatement = this.db.prepare("DELETE FROM party_events WHERE id = ?");
    this.selectAllStatement = this.db.prepare("SELECT event_json FROM party_events ORDER BY created_at ASC, id ASC");
  }

  loadEvents() {
    const events = [];
    for (const row of this.selectAllStatement.all()) {
      try {
        events.push(JSON.parse(row.event_json));
      } catch {
        // A bad row should not make the relay unbootable.
      }
    }
    return events;
  }

  insertEvent(event) {
    const result = this.insertStatement.run(
      event.id,
      tagValue(event.tags, "d") || "",
      event.kind,
      event.pubkey,
      event.created_at,
      Date.now(),
      JSON.stringify(event)
    );
    return result.changes > 0;
  }

  deleteEvents(ids) {
    for (const id of ids) this.deleteStatement.run(id);
  }

  close() {
    this.db.close();
  }
}

function createSqliteRelayStorage(storagePath) {
  return new SqliteRelayStorage(storagePath);
}

module.exports = {
  SqliteRelayStorage,
  createSqliteRelayStorage,
  sqliteFile
};
