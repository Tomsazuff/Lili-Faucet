const PTC_BANK_SHARE = 0.50;
const PTC_MINING_SHARE = 0.50;

// Publisher income:
// 95 % -> hlavný Bank
// 5 %  -> pozvaný používateľ
const PUBLISHER_WEB_SHARE = 0.95;
const PUBLISHER_USER_SHARE = 0.05;

const MIN_WITHDRAWAL_SATS = 100;

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

function cleanUserId(value) {
  return String(value || "").trim();
}

function cleanProvider(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function cleanReference(value) {
  return String(value || "").trim();
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
    ),

    db.prepare(
      "CREATE TABLE IF NOT EXISTS referrals (" +
      "user_id TEXT PRIMARY KEY, " +
      "referrer_id TEXT NOT NULL, " +
      "created_at TEXT NOT NULL)"
    ),

    db.prepare(
      "CREATE TABLE IF NOT EXISTS provider_earnings (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "provider TEXT NOT NULL, " +
      "user_id TEXT NOT NULL, " +
      "provider_ref TEXT NOT NULL, " +
      "publisher_sats INTEGER NOT NULL, " +
      "web_sats INTEGER NOT NULL, " +
      "user_sats INTEGER NOT NULL, " +
      "status TEXT NOT NULL DEFAULT 'confirmed', " +
      "created_at TEXT NOT NULL, " +
      "UNIQUE(provider, provider_ref)"
    ),

    db.prepare(
      "CREATE TABLE IF NOT EXISTS withdrawals (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "user_id TEXT NOT NULL, " +
      "amount_sats INTEGER NOT NULL, " +
      "method TEXT NOT NULL, " +
      "address TEXT NOT NULL, " +
      "status TEXT NOT NULL DEFAULT 'pending', " +
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
    }await db
    .prepare(
      "INSERT INTO users " +
      "(id, bank_sats, mining_sats, created_at) " +
      "VALUES (?, 0, 0, ?)"
    )
    .bind(userId, now())
    .run();

  return getUser(db, userId);
}

async function getReferral(db, userId) {
  return db
    .prepare(
      "SELECT * FROM referrals WHERE user_id = ?"
    )
    .bind(userId)
    .first();
}

async function setReferral(db, userId, referrerId) {
  userId = cleanUserId(userId);
  referrerId = cleanUserId(referrerId);

  if (!userId || !referrerId) {
    throw new Error("Chýba user_id alebo referrer_id.");
  }

  if (userId === referrerId) {
    throw new Error("Používateľ nemôže byť vlastným referralom.");
  }

  await ensureUser(db, userId);
  await ensureUser(db, referrerId);

  const existing = await getReferral(db, userId);

  if (existing) {
    return {
      user_id: userId,
      referrer_id: existing.referrer_id,
      existing: true
    };
  }

  await db
    .prepare(
      "INSERT INTO referrals " +
      "(user_id, referrer_id, created_at) " +
      "VALUES (?, ?, ?)"
    )
    .bind(userId, referrerId, now())
    .run();

  return {
    user_id: userId,
    referrer_id: referrerId,
    existing: false
  };
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
        .bind(additional, userId),

      db
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

  const cyclesResult = await db
    .prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? ORDER BY id DESC"
    )
    .bind(userId)
    .all();

  const referral = await getReferral(db, userId);

  const providerResult = await db
    .prepare(
      "SELECT " +
      "COALESCE(SUM(web_sats),0) AS web_sats, " +
      "COALESCE(SUM(user_sats),0) AS user_sats " +
      "FROM provider_earnings " +
      "WHERE user_id = ? AND status = 'confirmed'"
    )
    .bind(userId)
    .first();

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

    referral: referral || null,

    provider_totals: {
      web_sats: Number(providerResult?.web_sats || 0),
      user_sats: Number(providerResult?.user_sats || 0)
    },

    cycles: cyclesResult.results || []
  };
}

async function startMining(db, userId, durationDays) {
  const days = Number(durationDays);if (!ALLOWED_DAYS.includes(days)) {
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
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, bank_change_sats, " +
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
      .bind(bank, mining, userId),db
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

/*
  PROVIDER INCOME

  provider_amount_sats = skutočný publisher príjem,
  ktorý Lili Faucet dostane od providera.

  Z neho:
    95 % -> hlavný Bank
    5 %  -> používateľ, ktorý dokončil aktivitu.

  POZOR:
  Toto nie je 95/5 z advertiser spend.
  Je to 95/5 z publisher income.
*/

async function addProviderEarning(
  db,
  provider,
  userId,
  providerRef,
  publisherSats
) {
  provider = cleanProvider(provider);
  userId = cleanUserId(userId);
  providerRef = cleanReference(providerRef);

  const amount = Math.floor(
    Number(publisherSats)
  );

  if (
    !provider ||
    !userId ||
    !providerRef
  ) {
    throw new Error(
      "Chýba provider, user_id alebo provider_ref."
    );
  }

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Neplatný publisher príjem."
    );
  }

  await ensureUser(db, userId);

  const duplicate = await db
    .prepare(
      "SELECT * FROM provider_earnings " +
      "WHERE provider = ? AND provider_ref = ?"
    )
    .bind(
      provider,
      providerRef
    )
    .first();

  if (duplicate) {
    return {
      duplicate: true,
      earning_id: duplicate.id
    };
  }

  const webSats = Math.floor(
    amount * PUBLISHER_WEB_SHARE
  );

  const userSats =
    amount - webSats;

  await db.batch([
    db
      .prepare(
        "INSERT INTO provider_earnings " +
        "(provider, user_id, provider_ref, " +
        "publisher_sats, web_sats, user_sats, " +
        "status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)"
      )
      .bind(
        provider,
        userId,
        providerRef,
        amount,
        webSats,
        userSats,
        now()
      ),

    db
      .prepare(
        "UPDATE users " +
        "SET bank_sats = bank_sats + ? " +
        "WHERE id = ?"
      )
      .bind(
        webSats,
        userId
      ),

    db
      .prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, " +
        "bank_change_sats, mining_change_sats, " +
        "reference, created_at) " +
        "VALUES (?, 'PROVIDER_WEB_EARNING', ?, ?, 0, ?, ?)"
      )
      .bind(
        userId,
        webSats,
        webSats,
        provider + ":" + providerRef,
        now()
      )
  ]);

  /*
    5 % používateľa ide do jeho Bank.
    Nie je to samostatná platba z tvojho vrecka.
    Je to časť skutočného publisher príjmu.
  */

  if (userSats > 0) {
    await db
      .prepare(
        "UPDATE users " +
        "SET bank_sats = bank_sats + ? " +
        "WHERE id = ?"
      )
      .bind(
        userSats,
        userId
      )
      .run();

    await db
      .prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, " +
        "bank_change_sats, mining_change_sats, " +
        "reference, created_at) " +
        "VALUES (?, 'PROVIDER_USER_REWARD', ?, ?, 0, ?, ?)"
      )
      .bind(
        userId,
        userSats,
        userSats,
        provider + ":" + providerRef,
        now()
      )
      .run();
  }

  return {
    duplicate: false,
    provider,
    provider_ref: providerRef,
    publisher_sats: amount,
    web_sats: webSats,
    user_sats: userSats
  };
}

/*
  Jednoduchý všeobecný provider endpoint.Neskôr sem napojíme presné S2S postback formáty
  AdParagon, CoinlyAds a SplitGrid.
*/

async function providerPostback(
  db,
  provider,
  request
) {
  let body = {};

  const contentType =
    request.headers.get("content-type") || "";

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    body = await request.json();
  } else {
    const form =
      await request.formData();

    for (const [
      key,
      value
    ] of form.entries()) {
      body[key] = String(value);
    }
  }

  const userId = cleanUserId(
    body.user_id ||
    body.user ||
    body.uid ||
    body.sub_id
  );

  const providerRef = cleanReference(
    body.transaction_id ||
    body.transaction ||
    body.txid ||
    body.click_id ||
    body.ref ||
    body.provider_ref
  );

  /*
    Provider môže poslať:
      publisher_sats
      earn_sats
      reward_sats
      earn
      payout

    Presný prevod na sats ešte nastavíme
    podľa konkrétneho dashboardu providera.
  */

  const rawAmount =
    body.publisher_sats ??
    body.earn_sats ??
    body.reward_sats ??
    body.earn ??
    body.payout;

  const amount = Number(rawAmount);

  if (!userId) {
    return json(
      {
        ok: false,
        error: "Chýba user_id."
      },
      400
    );
  }

  if (!providerRef) {
    return json(
      {
        ok: false,
        error: "Chýba provider transaction/reference."
      },
      400
    );
  }

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return json(
      {
        ok: false,
        error:
          "Chýba platný publisher príjem."
      },
      400
    );
  }

  /*
    V tejto fáze očakávame sats.
    Ak provider posiela USD, presný kurz
    doplníme podľa jeho API/postback dokumentácie.
  */

  const result =
    await addProviderEarning(
      db,
      provider,
      userId,
      providerRef,
      amount
    );

  return json({
    ok: true,
    provider,
    ...result
  });
}

async function transferBankToMining(
  db,
  userId,
  amountSats
) {
  const amount = Math.floor(
    Number(amountSats)
  );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Neplatná suma."
    );
  }

  await ensureUser(db, userId);

  const user =
    await getUser(db, userId);

  if (
    Number(user.bank_sats) <
    amount
  ) {
    throw new Error(
      "V Banku nie je dostatok prostriedkov."
    );
  }

  await db.batch([
    db
      .prepare(
        "UPDATE users SET " +
        "bank_sats = bank_sats - ?, " +
        "mining_sats = mining_sats + ? " +
        "WHERE id = ?"
      )
      .bind(
        amount,
        amount,
        userId
      ),

    db
      .prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, " +
        "bank_change_sats, mining_change_sats, " +
        "reference, created_at) " +
        "VALUES (?, 'BANK_TO_MINING', ?, ?, ?, ?, ?)"
      )
      .bind(
        userId,
        amount,
        -amount,
        amount,
        "bank-to-mining",
        now()
      )
  ]);

  return {
    amount_sats: amount
  };
}

async function createWithdrawal(
  db,
  userId,
  amountSats,
  method,
  address
) {
  const amount = Math.floor(
    Number(amountSats)
  );

  method = String(
    method || ""
  ).trim();

  address = String(
    address || ""
  ).trim();

  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL_SATS
  ) {
    throw new Error(
  "Minimum výberu je " + MIN_WITHDRAWAL_SATS + " sats."
);
  }

  if (!method || !address) {
    throw new Error(
      "Chýba spôsob výberu alebo adresa."
    );
  }

  await ensureUser(db, userId);

  const user =
    await getUser(db, userId);

  if (
    Number(user.bank_sats) <
    amount
  ) {
    throw new Error(
      "V Banku nie je dostatok prostriedkov."
    );
    }const result =
    await db
      .prepare(
        "INSERT INTO withdrawals " +
        "(user_id, amount_sats, method, address, " +
        "status, created_at) " +
        "VALUES (?, ?, ?, ?, 'pending', ?)"
      )
      .bind(
        userId,
        amount,
        method,
        address,
        now()
      )
      .run();

  await db.batch([
    db
      .prepare(
        "UPDATE users " +
        "SET bank_sats = bank_sats - ? " +
        "WHERE id = ?"
      )
      .bind(
        amount,
        userId
      ),

    db
      .prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, " +
        "bank_change_sats, mining_change_sats, " +
        "reference, created_at) " +
        "VALUES (?, 'WITHDRAWAL', ?, ?, 0, ?, ?)"
      )
      .bind(
        userId,
        amount,
        -amount,
        "withdrawal:" +
        result.meta.last_row_id,
        now()
      )
  ]);

  return {
    withdrawal_id:
      result.meta.last_row_id,
    amount_sats: amount,
    method,
    status: "pending"
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
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

      const url =
        new URL(request.url);

      const path =
        url.pathname.replace(
          /\/+$/,
          ""
        ) || "/";

      if (path === "/") {
        return json({
          ok: true,
          service: "Lili Faucet Worker",
          status: "online",
          version: "3.0.0",
          publisher_split: {
            web: PUBLISHER_WEB_SHARE,
            invited_user:
              PUBLISHER_USER_SHARE
          },
          minimum_withdrawal_sats:
            MIN_WITHDRAWAL_SATS,
          providers: [
            "adparagon",
            "coinlyads",
            "splitgrid"
          ],
          mining_rates:
            MINING_RATES
        });
      }

      if (
        path === "/api/state" &&
        request.method === "GET"
      ) {
        const userId =
          cleanUserId(
            url.searchParams.get(
              "user_id"
            ) || "lili"
          );

        return json({
          ok: true,
          ...(await getState(
            env.DB,
            userId
          ))
        });
      }

      if (
        path === "/api/referral/set" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const result =
          await setReferral(
            env.DB,
            body.user_id,
            body.referrer_id
          );

        return json({
          ok: true,
          ...result
        });
      }

      if (
        path === "/api/mining/start" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const userId =
          cleanUserId(
            body.user_id || "lili"
          );

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
          cleanUserId(
            body.user_id || "lili"
          );

        const cycleId =
          Number(body.cycle_id);if (
          !Number.isInteger(
            cycleId
          ) ||
          cycleId <= 0
        ) {
          return json(
            {
              ok: false,
              error:
                "Neplatné cycle_id."
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
        path === "/api/bank/to-mining" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const userId =
          cleanUserId(
            body.user_id || "lili"
          );

        const result =
          await transferBankToMining(
            env.DB,
            userId,
            body.amount_sats
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
          cleanUserId(
            body.user_id || ""
          );

        const offerId =
          cleanReference(
            body.offer_id || ""
          );

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
              ? String(
                  body.provider_ref
                )
              : null
          );

        return json({
          ok: true,
          ...result
        });
      }

      /*
        SPOLOČNÝ PROVIDER POSTBACK

        /api/postback/adparagon
        /api/postback/coinlyads
        /api/postback/splitgrid
      */

      if (
        path.startsWith(
          "/api/postback/"
        ) &&
        request.method === "POST"
      ) {
        const provider =
          cleanProvider(
            path.split(
              "/"
            )[3]
          );

        const allowed = [
          "adparagon",
          "coinlyads",
          "splitgrid"
        ];

        if (
          !allowed.includes(
            provider
          )
        ) {
          return json(
            {
              ok: false,
              error:
                "Neznámy provider."
            },
            400
          );
        }

        return await providerPostback(
          env.DB,
          provider,
          request
        );
      }

      if (
        path === "/api/withdraw" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const result =
          await createWithdrawal(
            env.DB,
            cleanUserId(
              body.user_id || ""
            ),
            body.amount_sats,
            body.method,
            body.address
          );

        return json({
          ok: true,
          ...result
        });
      }

      if (
        path === "/api/provider-earnings" &&
        request.method === "GET"
      ) {
        const userId =
          cleanUserId(
            url.searchParams.get(
              "user_id"
            ) || "lili"
          );

        const result =
          await env.DB
            .prepare(
              "SELECT * FROM provider_earnings " +
              "WHERE user_id = ? " +
              "ORDER BY id DESC LIMIT 100"
            )
            .bind(userId)
            .all();

        return json({
          ok: true,
          earnings:
            result.results || []
        });
      }if (
        path === "/api/transactions" &&
        request.method === "GET"
      ) {
        const userId =
          cleanUserId(
            url.searchParams.get(
              "user_id"
            ) || "lili"
          );

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

      if (
        path === "/api/withdrawals" &&
        request.method === "GET"
      ) {
        const userId =
          cleanUserId(
            url.searchParams.get(
              "user_id"
            ) || "lili"
          );

        const result =
          await env.DB
            .prepare(
              "SELECT * FROM withdrawals " +
              "WHERE user_id = ? " +
              "ORDER BY id DESC LIMIT 100"
            )
            .bind(userId)
            .all();

        return json({
          ok: true,
          withdrawals:
            result.results || []
        });
      }

      return json(
        {
          ok: false,
          error:
            "Endpoint neexistuje."
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
