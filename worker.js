/**
 * Lili Faucet — Cloudflare Worker backend
 *
 * D1 binding required:
 *   DB -> lili-faucet-db
 *
 * PTC revenue split:
 *   50% -> Bank
 *   50% -> Mining
 *
 * The mining balance is internal accounting. It does not create real BTC.
 * Real withdrawals require real revenue/funds and a server-side FaucetPay
 * integration. Never put a FaucetPay API key in index.html.
 */

const PTC_BANK_SHARE = 0.50;
const PTC_MINING_SHARE = 0.50;

// Keep this at 0 until the mining yield is backed by real site revenue.
const MINING_DAILY_RATE = 0;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    }
  });
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isoNow() {
  return new Date().toISOString();
}

function daysBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / 86400000);
}

async function schema(db) {
  await db.batch([
    db.prepare(
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        bank_sats INTEGER NOT NULL DEFAULT 0,
        mining_sats INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        bank_change_sats INTEGER NOT NULL DEFAULT 0,
        mining_change_sats INTEGER NOT NULL DEFAULT 0,
        reference TEXT,
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS mining_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        principal_sats INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        earned_sats INTEGER NOT NULL DEFAULT 0,
        released_at TEXT
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS ptc_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        reward_sats INTEGER NOT NULL,
        provider_ref TEXT,
        created_at TEXT NOT NULL
      )
    )
  ]);
}

async function getUser(db, id) {
  return db
    .prepare(SELECT * FROM users WHERE id = ?)
    .bind(id)
    .first();
}

async function ensureUser(db, id) {
  let u = await getUser(db, id);

  if (u) return u;

  await db.prepare(
    INSERT INTO users (id, bank_sats, mining_sats, created_at)
    VALUES (?, 0, 0, ?)
  )
  .bind(id, isoNow())
  .run();

  return getUser(db, id);
}

async function accrueMining(db, userId) {
  if (MINING_DAILY_RATE <= 0) return;

  const rows = await db.prepare(
    SELECT * FROM mining_cycles
    WHERE user_id = ? AND status = 'active'
  )
  .bind(userId)
  .all();

  for (const c of (rows.results || [])) {
    const elapsed = Math.min(
      Number(c.duration_days),
      daysBetween(c.started_at, isoNow())
    );

    const target = Math.floor(
      Number(c.principal_sats) *
      MINING_DAILY_RATE *
      elapsed
    );

    const extra = Math.max(
      0,
      target - Number(c.earned_sats || 0)
    );

    if (!extra) continue;

    await db.batch([
      db.prepare(
        UPDATE mining_cycles
        SET earned_sats = earned_sats + ?
        WHERE id = ?
      )
      .bind(extra, c.id),

      db.prepare(
        UPDATE users
        SET mining_sats = mining_sats + ?
        WHERE id = ?
      )
      .bind(extra, userId),db.prepare(
        INSERT INTO transactions
        (
          user_id,
          type,
          amount_sats,
          bank_change_sats,
          mining_change_sats,
          reference,
          created_at
        )
        VALUES (?, 'MINING_YIELD', ?, 0, ?, ?, ?)
      )
      .bind(
        userId,
        extra,
        extra,
        cycle:${c.id},
        isoNow()
      )
    ]);
  }
}

async function state(db, userId) {
  await ensureUser(db, userId);
  await accrueMining(db, userId);

  const u = await getUser(db, userId);

  const cycles = await db.prepare(
    SELECT * FROM mining_cycles
    WHERE user_id = ?
    ORDER BY id DESC
  )
  .bind(userId)
  .all();

  return {
    user_id: u.id,

    bank_sats: Number(u.bank_sats),
    mining_sats: Number(u.mining_sats),

    bank_btc: (
      Number(u.bank_sats) / 100000000
    ).toFixed(8),

    mining_btc: (
      Number(u.mining_sats) / 100000000
    ).toFixed(8),

    mining_daily_rate: MINING_DAILY_RATE,

    cycles: cycles.results || []
  };
}

async function addPtcReward(
  db,
  userId,
  offerId,
  rewardSats,
  providerRef
) {
  const reward = Math.floor(Number(rewardSats));

  if (!Number.isFinite(reward) || reward <= 0) {
    throw new Error("Invalid reward_sats");
  }

  await ensureUser(db, userId);

  if (providerRef) {
    const old = await db.prepare(
      SELECT id
      FROM ptc_completions
      WHERE provider_ref = ?
      LIMIT 1
    )
    .bind(providerRef)
    .first();

    if (old) {
      return {
        duplicate: true,
        completion_id: old.id
      };
    }
  }

  const bank = Math.floor(
    reward * PTC_BANK_SHARE
  );

  const mining = reward - bank;

  const result = await db.batch([
    db.prepare(
      UPDATE users
      SET
        bank_sats = bank_sats + ?,
        mining_sats = mining_sats + ?
      WHERE id = ?
    )
    .bind(
      bank,
      mining,
      userId
    ),

    db.prepare(
      INSERT INTO transactions
      (
        user_id,
        type,
        amount_sats,
        bank_change_sats,
        mining_change_sats,
        reference,
        created_at
      )
      VALUES (?, 'PTC_REWARD', ?, ?, ?, ?, ?)
    )
    .bind(
      userId,
      reward,
      bank,
      mining,
      offerId,
      isoNow()
    ),

    db.prepare(
      INSERT INTO ptc_completions
      (
        user_id,
        offer_id,
        reward_sats,
        provider_ref,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    )
    .bind(
      userId,
      offerId,
      reward,
      providerRef || null,
      isoNow()
    )
  ]);

  return {
    duplicate: false,
    reward_sats: reward,
    bank_sats: bank,
    mining_sats: mining,
    result
  };
}

async function startMining(
  db,
  userId,
  durationDays
) {
  const days = Number(durationDays);

  if (![1, 5, 10, 20, 30].includes(days)) {
    throw new Error(
      "Duration must be 1, 5, 10, 20 or 30 days"
    );
  }

  await ensureUser(db, userId);
  await accrueMining(db, userId);

  const u = await getUser(db, userId);

  const amount = Number(u.mining_sats);

  if (amount <= 0) {
    throw new Error("Mining balance is empty");
  }

  const started = new Date();

  const ends = new Date(
    started.getTime() +
    days * 86400000
  );

  const inserted = await db.prepare(
    INSERT INTO mining_cycles
    (
      user_id,
      principal_sats,
      started_at,
      duration_days,
      ends_at,
      status,
      earned_sats
    )
    VALUES (?, ?, ?, ?, ?, 'active', 0)
  )
  .bind(
    userId,
    amount,
    started.toISOString(),
    days,
    ends.toISOString()
  )
  .run();

  await db.batch([
    db.prepare(
      UPDATE users
      SET mining_sats = 0
      WHERE id = ?
    )
    .bind(userId),

    db.prepare(`
      INSERT INTO transactionsdb.prepare(
        INSERT INTO transactions
        (
          user_id,
          type,
          amount_sats,
          bank_change_sats,
          mining_change_sats,
          reference,
          created_at
        )
        VALUES (?, 'MINING_YIELD', ?, 0, ?, ?, ?)
      )
      .bind(
        userId,
        extra,
        extra,
        cycle:${c.id},
        isoNow()
      )
    ]);
  }
}

async function state(db, userId) {
  await ensureUser(db, userId);
  await accrueMining(db, userId);

  const u = await getUser(db, userId);

  const cycles = await db.prepare(
    SELECT * FROM mining_cycles
    WHERE user_id = ?
    ORDER BY id DESC
  )
  .bind(userId)
  .all();

  return {
    user_id: u.id,

    bank_sats: Number(u.bank_sats),
    mining_sats: Number(u.mining_sats),

    bank_btc: (
      Number(u.bank_sats) / 100000000
    ).toFixed(8),

    mining_btc: (
      Number(u.mining_sats) / 100000000
    ).toFixed(8),

    mining_daily_rate: MINING_DAILY_RATE,

    cycles: cycles.results || []
  };
}

async function addPtcReward(
  db,
  userId,
  offerId,
  rewardSats,
  providerRef
) {
  const reward = Math.floor(Number(rewardSats));

  if (!Number.isFinite(reward) || reward <= 0) {
    throw new Error("Invalid reward_sats");
  }

  await ensureUser(db, userId);

  if (providerRef) {
    const old = await db.prepare(
      SELECT id
      FROM ptc_completions
      WHERE provider_ref = ?
      LIMIT 1
    )
    .bind(providerRef)
    .first();

    if (old) {
      return {
        duplicate: true,
        completion_id: old.id
      };
    }
  }

  const bank = Math.floor(
    reward * PTC_BANK_SHARE
  );

  const mining = reward - bank;

  const result = await db.batch([
    db.prepare(
      UPDATE users
      SET
        bank_sats = bank_sats + ?,
        mining_sats = mining_sats + ?
      WHERE id = ?
    )
    .bind(
      bank,
      mining,
      userId
    ),

    db.prepare(
      INSERT INTO transactions
      (
        user_id,
        type,
        amount_sats,
        bank_change_sats,
        mining_change_sats,
        reference,
        created_at
      )
      VALUES (?, 'PTC_REWARD', ?, ?, ?, ?, ?)
    )
    .bind(
      userId,
      reward,
      bank,
      mining,
      offerId,
      isoNow()
    ),

    db.prepare(
      INSERT INTO ptc_completions
      (
        user_id,
        offer_id,
        reward_sats,
        provider_ref,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    )
    .bind(
      userId,
      offerId,
      reward,
      providerRef || null,
      isoNow()
    )
  ]);

  return {
    duplicate: false,
    reward_sats: reward,
    bank_sats: bank,
    mining_sats: mining,
    result
  };
}

async function startMining(
  db,
  userId,
  durationDays
) {
  const days = Number(durationDays);

  if (![1, 5, 10, 20, 30].includes(days)) {
    throw new Error(
      "Duration must be 1, 5, 10, 20 or 30 days"
    );
  }

  await ensureUser(db, userId);
  await accrueMining(db, userId);

  const u = await getUser(db, userId);

  const amount = Number(u.mining_sats);

  if (amount <= 0) {
    throw new Error("Mining balance is empty");
  }

  const started = new Date();

  const ends = new Date(
    started.getTime() +
    days * 86400000
  );

  const inserted = await db.prepare(
    INSERT INTO mining_cycles
    (
      user_id,
      principal_sats,
      started_at,
      duration_days,
      ends_at,
      status,
      earned_sats
    )
    VALUES (?, ?, ?, ?, ?, 'active', 0)
  )
  .bind(
    userId,
    amount,
    started.toISOString(),
    days,
    ends.toISOString()
  )
  .run();

  await db.batch([
    db.prepare(
      UPDATE users
      SET mining_sats = 0
      WHERE id = ?
    )
    .bind(userId),

    db.prepare(`
      INSERT INTO transactions(
        user_id,
        type,
        amount_sats,
        bank_change_sats,
        mining_change_sats,
        reference,
        created_at
      )
      VALUES (?, 'MINING_START', ?, 0, ?, ?, ?)
    )
    .bind(
      userId,
      amount,
      -amount,
      cycle:${inserted.meta.last_row_id},
      isoNow()
    )
  ]);

  return {
    cycle_id: inserted.meta.last_row_id,
    principal_sats: amount,
    duration_days: days,
    ends_at: ends.toISOString()
  };
}

async function releaseMining(
  db,
  userId,
  cycleId
) {
  await accrueMining(db, userId);

  const c = await db.prepare(
    SELECT *
    FROM mining_cycles
    WHERE id = ?
      AND user_id = ?
  )
  .bind(
    cycleId,
    userId
  )
  .first();

  if (!c) {
    throw new Error(
      "Mining cycle not found"
    );
  }

  if (c.status !== "active") {
    throw new Error(
      "Mining cycle already released"
    );
  }

  if (
    new Date(c.ends_at).getTime() >
    Date.now()
  ) {
    throw new Error(
      "Mining cycle has not ended yet"
    );
  }

  const total =
    Number(c.principal_sats) +
    Number(c.earned_sats);

  await db.batch([
    db.prepare(
      UPDATE users
      SET bank_sats = bank_sats + ?
      WHERE id = ?
    )
    .bind(total, userId),

    db.prepare(
      UPDATE mining_cycles
      SET
        status = 'released',
        released_at = ?
      WHERE id = ?
    )
    .bind(
      isoNow(),
      cycleId
    ),

    db.prepare(
      INSERT INTO transactions
      (
        user_id,
        type,
        amount_sats,
        bank_change_sats,
        mining_change_sats,
        reference,
        created_at
      )
      VALUES (?, 'MINING_RELEASE', ?, ?, 0, ?, ?)
    )
    .bind(
      userId,
      total,
      total,
      cycle:${cycleId}`,
      isoNow()
    )
  ]);

  return {
    cycle_id: cycleId,
    released_sats: total
  };
}

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,

        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods":
            "GET,POST,OPTIONS",
          "access-control-allow-headers":
            "content-type, authorization"
        }
      });
    }

    if (!env.DB) {
      return json({
        ok: false,
        error: "D1 binding DB is missing"
      }, 500);
    }

    try {

      await schema(env.DB);

      const url = new URL(
        request.url
      );

      const path =
        url.pathname.replace(
          /\/+$/,
          ""
        ) || "/";

      if (path === "/") {
        return json({
          ok: true,
          service:
            "Lili Faucet Worker",
          status: "online",
          version: "1.0.0"
        });
      }

      if (
        path === "/api/setup" &&
        request.method === "POST"
      ) {
        return json({
          ok: true,
          message:
            "D1 tables are ready"
        });
      }

      if (
        path === "/api/state" &&
        request.method === "GET"
      ) {

        const userId =
          url.searchParams.get(
            "user_id"
          ) || "lili";

        return json({
          ok: true,
          ...(await state(
            env.DB,
            userId
          ))
        });
      }

      if (
        path === "/api/user" &&
        request.method === "POST"
      ) {

        const b =
          await bodyJson(request);

        const userId =
          String(
            b.user_id || "lili"
          ).trim();

        if (
          !/^[A-Za-z0-9_-]{1,64}$/
            .test(userId)
        ) {
          return json({
            ok: false,
            error:
              "Invalid user_id"
          }, 400);
        }

        return json({
          ok: true,
          ...(await state(
            env.DB,
            userId
          ))
        });
      }

      if (
        path === "/api/ptc/reward" &&
        request.method === "POST"
      ) {/*
         * Trusted provider callback endpoint.
         * A real PTC provider must call this only
         * after a valid completion.
         */

        const b =
          await bodyJson(request);

        const userId =
          String(
            b.user_id || ""
          ).trim();

        const offerId =
          String(
            b.offer_id || ""
          ).trim();

        if (
          !userId ||
          !offerId ||
          !b.reward_sats
        ) {
          return json({
            ok: false,
            error:
              "user_id, offer_id and reward_sats are required"
          }, 400);
        }

        return json({
          ok: true,

          ...(await addPtcReward(
            env.DB,
            userId,
            offerId,
            b.reward_sats,
            b.provider_ref
              ? String(
                  b.provider_ref
                )
              : null
          ))
        });
      }

      if (
        path === "/api/mining/start" &&
        request.method === "POST"
      ) {

        const b =
          await bodyJson(request);

        const userId =
          String(
            b.user_id || "lili"
          ).trim();

        return json({
          ok: true,

          message:
            "Mining cycle started",

          ...(await startMining(
            env.DB,
            userId,
            b.duration_days
          ))
        });
      }

      if (
        path === "/api/mining/release" &&
        request.method === "POST"
      ) {

        const b =
          await bodyJson(request);

        const userId =
          String(
            b.user_id || "lili"
          ).trim();

        const cycleId =
          Number(b.cycle_id);

        if (
          !Number.isInteger(
            cycleId
          ) ||
          cycleId <= 0
        ) {
          return json({
            ok: false,
            error:
              "Valid cycle_id is required"
          }, 400);
        }

        return json({
          ok: true,

          message:
            "Mining moved to Bank",

          ...(await releaseMining(
            env.DB,
            userId,
            cycleId
          ))
        });
      }

      if (
        path === "/api/transactions" &&
        request.method === "GET"
      ) {

        const userId =
          url.searchParams.get(
            "user_id"
          ) || "lili";

        const rows =
          await env.DB.prepare(
            SELECT *
            FROM transactions
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 100
          )
          .bind(userId)
          .all();

        return json({
          ok: true,
          transactions:
            rows.results || []
        });
      }

      return json({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (e) {

      console.error(e);

      return json({
        ok: false,
        error:
          e?.message ||
          String(e)
      }, 500);
    }
  }
};
