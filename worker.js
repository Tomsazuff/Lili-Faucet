const PTC_BANK_SHARE = 0.50;
const PTC_MINING_SHARE = 0.50;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const ALLOWED_DAYS = [1, 5, 10, 20, 30];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function now() {
  return new Date().toISOString();
}

function rateFor(days) {
  return MINING_RATES[Number(days)] || 0;
}

function elapsedDays(start, end) {
  return Math.max(
    0,
    (new Date(end).getTime() - new Date(start).getTime()) / 86400000
  );
}

async function createTables(db) {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS users (" +
      "id TEXT PRIMARY KEY, " +
      "bank_sats INTEGER NOT NULL DEFAULT 0, " +
      "mining_sats INTEGER NOT NULL DEFAULT 0, " +
      "created_at TEXT NOT NULL)"
    ),

    db.prepare(
      "CREATE TABLE IF NOT EXISTS transactions (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "user_id TEXT NOT NULL, " +
      "type TEXT NOT NULL, " +
      "amount_sats INTEGER NOT NULL, " +
      "bank_change_sats INTEGER NOT NULL DEFAULT 0, " +
      "mining_change_sats INTEGER NOT NULL DEFAULT 0, " +
      "reference TEXT, " +
      "created_at TEXT NOT NULL)"
    ),

    db.prepare(
      "CREATE TABLE IF NOT EXISTS mining_cycles (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "user_id TEXT NOT NULL, " +
      "principal_sats INTEGER NOT NULL, " +
      "started_at TEXT NOT NULL, " +
      "duration_days INTEGER NOT NULL, " +
      "ends_at TEXT NOT NULL, " +
      "status TEXT NOT NULL DEFAULT 'active', " +
      "earned_sats INTEGER NOT NULL DEFAULT 0, " +
      "released_at TEXT)"
    ),

    db.prepare(
      "CREATE TABLE IF NOT EXISTS ptc_completions (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "user_id TEXT NOT NULL, " +
      "offer_id TEXT NOT NULL, " +
      "reward_sats INTEGER NOT NULL, " +
      "provider_ref TEXT, " +
      "created_at TEXT NOT NULL)"
    )
  ]);
}

async function getUser(db, userId) {
  return db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
}

async function ensureUser(db, userId) {
  let user = await getUser(db, userId);

  if (user) {
    return user;
  }

  await db
    .prepare(
      "INSERT INTO users " +
      "(id, bank_sats, mining_sats, created_at) " +
      "VALUES (?, 0, 0, ?)"
    )
    .bind(userId, now())
    .run();

  return getUser(db, userId);
}

async function accrueMining(db, userId) {
  const result = await db
    .prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? AND status = 'active'"
    )
    .bind(userId)
    .all();

  const cycles = result.results || [];

  for (const cycle of cycles) {
    const days = Number(cycle.duration_days);
    const rate = rateFor(days);

    if (!rate) {
      continue;
    }

    const elapsed = Math.min(
      days,
      elapsedDays(cycle.started_at, now())
    );

    const targetEarned = Math.floor(
      Number(cycle.principal_sats) *
      rate *
      (elapsed / days)
    );

    const alreadyEarned = Number(cycle.earned_sats || 0);

    const additional = Math.max(
      0,
      targetEarned - alreadyEarned
    );

    if (additional <= 0) {
      continue;
    }

    await db.batch([
      db
        .prepare(
          "UPDATE mining_cycles " +
          "SET earned_sats = earned_sats + ? " +
          "WHERE id = ?"
        )
        .bind(additional, cycle.id),

      db
        .prepare(
          "UPDATE users " +
          "SET mining_sats = mining_sats + ? " +
          "WHERE id = ?"
        )
        .bind(additional, userId),db
        .prepare(
          "INSERT INTO transactions " +
          "(user_id, type, amount_sats, bank_change_sats, " +
          "mining_change_sats, reference, created_at) " +
          "VALUES (?, 'MINING_YIELD', ?, 0, ?, ?, ?)"
        )
        .bind(
          userId,
          additional,
          additional,
          "cycle:" + cycle.id,
          now()
        )
    ]);
  }
}

async function getState(db, userId) {
  await ensureUser(db, userId);
  await accrueMining(db, userId);

  const user = await getUser(db, userId);

  const result = await db
    .prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? ORDER BY id DESC"
    )
    .bind(userId)
    .all();

  return {
    user_id: user.id,

    bank_sats: Number(user.bank_sats),
    mining_sats: Number(user.mining_sats),

    bank_btc: (
      Number(user.bank_sats) / 100000000
    ).toFixed(8),

    mining_btc: (
      Number(user.mining_sats) / 100000000
    ).toFixed(8),

    mining_rates: MINING_RATES,

    cycles: result.results || []
  };
}

async function startMining(db, userId, durationDays) {
  const days = Number(durationDays);

  if (!ALLOWED_DAYS.includes(days)) {
    throw new Error(
      "Povolené cykly sú 1, 5, 10, 20 alebo 30 dní."
    );
  }

  await ensureUser(db, userId);
  await accrueMining(db, userId);

  const user = await getUser(db, userId);
  const amount = Number(user.mining_sats);

  if (amount <= 0) {
    throw new Error(
      "Mining zostatok je 0. Najprv získaj Mining odmenu."
    );
  }

  const startDate = new Date();

  const endDate = new Date(
    startDate.getTime() +
    days * 86400000
  );

  const result = await db
    .prepare(
      "INSERT INTO mining_cycles " +
      "(user_id, principal_sats, started_at, duration_days, " +
      "ends_at, status, earned_sats) " +
      "VALUES (?, ?, ?, ?, ?, 'active', 0)"
    )
    .bind(
      userId,
      amount,
      startDate.toISOString(),
      days,
      endDate.toISOString()
    )
    .run();

  const cycleId = result.meta.last_row_id;

  await db.batch([
    db
      .prepare(
        "UPDATE users " +
        "SET mining_sats = 0 " +
        "WHERE id = ?"
      )
      .bind(userId),

    db
      .prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, bank_change_sats, " +
        "mining_change_sats, reference, created_at) " +
        "VALUES (?, 'MINING_START', ?, 0, ?, ?, ?)"
      )
      .bind(
        userId,
        amount,
        -amount,
        "cycle:" + cycleId,
        now()
      )
  ]);

  return {
    cycle_id: cycleId,
    principal_sats: amount,
    duration_days: days,
    rate: rateFor(days),
    ends_at: endDate.toISOString()
  };
}

async function releaseMining(db, userId, cycleId) {
  await accrueMining(db, userId);

  const cycle = await db
    .prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE id = ? AND user_id = ?"
    )
    .bind(cycleId, userId)
    .first();

  if (!cycle) {
    throw new Error("Mining cyklus neexistuje.");
  }

  if (cycle.status !== "active") {
    throw new Error("Mining cyklus už bol presunutý.");
  }

  if (
    new Date(cycle.ends_at).getTime() >
    Date.now()
  ) {
    throw new Error(
      "Mining cyklus ešte neskončil."
    );
  }

  const principal = Number(
    cycle.principal_sats
  );

  const earned = Number(
    cycle.earned_sats || 0
  );

  const total = principal + earned;

  await db.batch([
    db
      .prepare(
        "UPDATE users " +
        "SET bank_sats = bank_sats + ? " +
        "WHERE id = ?"
      )
      .bind(total, userId),

    db
      .prepare(
        "UPDATE mining_cycles " +
        "SET status = 'released', released_at = ? " +
        "WHERE id = ?"
      )
      .bind(now(), cycleId),

    db
      .prepare(
        "INSERT INTO transactions " +"(user_id, type, amount_sats, bank_change_sats, " +
        "mining_change_sats, reference, created_at) " +
        "VALUES (?, 'MINING_RELEASE', ?, ?, 0, ?, ?)"
      )
      .bind(
        userId,
        total,
        total,
        "cycle:" + cycleId,
        now()
      )
  ]);

  return {
    cycle_id: cycleId,
    released_sats: total
  };
}

async function addPtcReward(
  db,
  userId,
  offerId,
  rewardSats,
  providerRef
) {
  const reward = Math.floor(
    Number(rewardSats)
  );

  if (!Number.isFinite(reward) || reward <= 0) {
    throw new Error("Neplatná PTC odmena.");
  }

  await ensureUser(db, userId);

  if (providerRef) {
    const duplicate = await db
      .prepare(
        "SELECT id FROM ptc_completions " +
        "WHERE provider_ref = ? LIMIT 1"
      )
      .bind(providerRef)
      .first();

    if (duplicate) {
      return {
        duplicate: true,
        completion_id: duplicate.id
      };
    }
  }

  const bank = Math.floor(
    reward * PTC_BANK_SHARE
  );

  const mining =
    reward - bank;

  await db.batch([
    db
      .prepare(
        "UPDATE users SET " +
        "bank_sats = bank_sats + ?, " +
        "mining_sats = mining_sats + ? " +
        "WHERE id = ?"
      )
      .bind(bank, mining, userId),

    db
      .prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, bank_change_sats, " +
        "mining_change_sats, reference, created_at) " +
        "VALUES (?, 'PTC_REWARD', ?, ?, ?, ?, ?)"
      )
      .bind(
        userId,
        reward,
        bank,
        mining,
        offerId,
        now()
      ),

    db
      .prepare(
        "INSERT INTO ptc_completions " +
        "(user_id, offer_id, reward_sats, " +
        "provider_ref, created_at) " +
        "VALUES (?, ?, ?, ?, ?)"
      )
      .bind(
        userId,
        offerId,
        reward,
        providerRef || null,
        now()
      )
  ]);

  return {
    duplicate: false,
    reward_sats: reward,
    bank_sats: bank,
    mining_sats: mining
  };
}

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    if (!env.DB) {
      return json(
        {
          ok: false,
          error: "D1 binding DB chýba."
        },
        500
      );
    }

    try {
      await createTables(env.DB);

      const url = new URL(request.url);
      const path =
        url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        return json({
          ok: true,
          service: "Lili Faucet Worker",
          status: "online",
          version: "2.0.0",
          mining_rates: MINING_RATES
        });
      }

      if (
        path === "/api/state" &&
        request.method === "GET"
      ) {
        const userId =
          url.searchParams.get("user_id") ||
          "lili";

        return json({
          ok: true,
          ...(await getState(
            env.DB,
            userId
          ))
        });
      }

      if (
        path === "/api/mining/start" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const userId =
          String(
            body.user_id || "lili"
          ).trim();

        const result =
          await startMining(
            env.DB,
            userId,
            body.duration_days
          );

        return json({
          ok: true,
          ...result
        });
      }

      if (
        path === "/api/mining/release" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const userId =
          String(
            body.user_id || "lili"
          ).trim();

        const cycleId =
          Number(body.cycle_id);if (
          !Number.isInteger(cycleId) ||
          cycleId <= 0
        ) {
          return json(
            {
              ok: false,
              error: "Neplatné cycle_id."
            },
            400
          );
        }

        const result =
          await releaseMining(
            env.DB,
            userId,
            cycleId
          );

        return json({
          ok: true,
          ...result
        });
      }

      if (
        path === "/api/ptc/reward" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const userId =
          String(
            body.user_id || ""
          ).trim();

        const offerId =
          String(
            body.offer_id || ""
          ).trim();

        if (
          !userId ||
          !offerId ||
          !body.reward_sats
        ) {
          return json(
            {
              ok: false,
              error:
                "Chýba user_id, offer_id alebo reward_sats."
            },
            400
          );
        }

        const result =
          await addPtcReward(
            env.DB,
            userId,
            offerId,
            body.reward_sats,
            body.provider_ref
              ? String(body.provider_ref)
              : null
          );

        return json({
          ok: true,
          ...result
        });
      }

      if (
        path === "/api/transactions" &&
        request.method === "GET"
      ) {
        const userId =
          url.searchParams.get("user_id") ||
          "lili";

        const result =
          await env.DB
            .prepare(
              "SELECT * FROM transactions " +
              "WHERE user_id = ? " +
              "ORDER BY id DESC LIMIT 100"
            )
            .bind(userId)
            .all();

        return json({
          ok: true,
          transactions:
            result.results || []
        });
      }

      return json(
        {
          ok: false,
          error: "Endpoint neexistuje."
        },
        404
      );

    } catch (error) {

      console.error(error);

      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
