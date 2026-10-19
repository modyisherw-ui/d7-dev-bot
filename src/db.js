const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "d7dev.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// جدول التذاكر القديم كان بصيغة topic/text بدون رقم تذكرة — نعيد بناءه مرة واحدة
const oldTickets = db.prepare(`PRAGMA table_info(tickets)`).all();
if (oldTickets.length && !oldTickets.some(c => c.name === "number")) {
  console.log("Migrating tickets table to the numbered ticket schema…");
  db.exec(`DROP TABLE IF EXISTS ticket_ratings; DROP TABLE IF EXISTS tickets;`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'SAR',
  role_id TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  download_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'working',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TEXT DEFAULT NULL,
  delivered_at TEXT DEFAULT NULL,
  delivery_seconds INTEGER DEFAULT NULL,
  rating INTEGER DEFAULT NULL,
  review TEXT DEFAULT '',
  confirmed_by TEXT DEFAULT '',
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'support',
  number INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'open',
  claimed_by TEXT DEFAULT NULL,
  answers TEXT DEFAULT '{}',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  closed_at INTEGER DEFAULT NULL,
  closed_by TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS ticket_counter (
  guild_id TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ticket_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  feedback TEXT DEFAULT '',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);
CREATE TABLE IF NOT EXISTS product_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  review TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stars INTEGER NOT NULL,
  comment TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ═══════════════ Tickets (numbered, one channel per ticket) ═══════════════
db.tickets = {
  nextNumber(guildId) {
    db.prepare(`INSERT INTO ticket_counter (guild_id, count) VALUES (?,1) ON CONFLICT(guild_id) DO UPDATE SET count = count + 1`).run(guildId);
    return db.prepare(`SELECT count FROM ticket_counter WHERE guild_id=?`).get(guildId).count;
  },
  create: ({ channelId, guildId, userId, type, number }) =>
    db.prepare(`INSERT INTO tickets (channel_id, guild_id, user_id, type, number) VALUES (?,?,?,?,?)`).run(channelId, guildId, userId, type, number),
  get: (channelId) => db.prepare(`SELECT * FROM tickets WHERE channel_id=?`).get(channelId) || null,
  getUserOpen: (userId, guildId) => db.prepare(`SELECT * FROM tickets WHERE user_id=? AND guild_id=? AND status='open'`).all(userId, guildId),
  getOpen: (guildId) => db.prepare(`SELECT * FROM tickets WHERE guild_id=? AND status='open' ORDER BY created_at DESC`).all(guildId),
  claim: (channelId, userId) => db.prepare(`UPDATE tickets SET claimed_by=? WHERE channel_id=?`).run(userId, channelId),
  unclaim: (channelId) => db.prepare(`UPDATE tickets SET claimed_by=NULL WHERE channel_id=?`).run(channelId),
  close: (channelId, closedBy) => db.prepare(`UPDATE tickets SET status='closed', closed_at=strftime('%s','now'), closed_by=? WHERE channel_id=?`).run(closedBy, channelId),
  stats: (guildId) => {
    const q = (sql) => db.prepare(sql).get(guildId).c;
    return {
      total: q(`SELECT COUNT(*) c FROM tickets WHERE guild_id=?`),
      open: q(`SELECT COUNT(*) c FROM tickets WHERE guild_id=? AND status='open'`),
      closed: q(`SELECT COUNT(*) c FROM tickets WHERE guild_id=? AND status='closed'`),
      today: q(`SELECT COUNT(*) c FROM tickets WHERE guild_id=? AND created_at > strftime('%s','now') - 86400`),
    };
  },
  saveRating: (ticketId, userId, rating, feedback) =>
    db.prepare(`INSERT OR REPLACE INTO ticket_ratings (ticket_id, user_id, rating, feedback) VALUES (?,?,?,?)`).run(ticketId, userId, rating, feedback),
};

// ═══════════════ Ratings (NSR-style product ratings) ═══════════════
db.ratings = {
  add: ({ guildId, productId, userId, stars, comment }) =>
    db.prepare(`INSERT INTO ratings (guild_id, product_id, user_id, stars, comment) VALUES (?,?,?,?,?)`)
      .run(guildId || "", String(productId), userId, stars, comment || ""),
  byProduct: (productId) =>
    db.prepare(`SELECT COUNT(*) n, COALESCE(AVG(stars),0) avg FROM ratings WHERE product_id=?`).get(String(productId)),
};

module.exports = db;
