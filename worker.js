Pata Hutira:
const PTC_BANK_SHARE = 0.50;
const PTC_MINING_SHARE = 0.50;

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

const OWNER_USER_ID = "lili";

const AoyCo_API_KEY =
  "qWUls6MqCgbYt3jj34cFL33rWzjC4POJ";


function now() {
  return new Date().toISOString();
}


function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type",
        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS"
      }
    }
  );

}


function error(message, status = 400) {

  return json(
    {
      ok: false,
      error: message
    },
    status
  );

}


async function readJson(request) {

  try {
    return await request.json();
  } catch {
    return {};
  }

}


// ==================================================
// DATABASE
// ==================================================

async function createTables(db) {

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
        days INTEGER NOT NULL,
        rate REAL NOT NULL,
        started_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        released_at TEXT
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS ptc_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_ref TEXT,
        amount_sats INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider, provider_ref)
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS referrals (
        user_id TEXT PRIMARY KEY,
        referrer_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS provider_earnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_ref TEXT,
        publisher_sats INTEGER NOT NULL DEFAULT 0,
        web_sats INTEGER NOT NULL DEFAULT 0,
        user_sats INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'paid',
        created_at TEXT NOT NULL,
        UNIQUE(provider, provider_ref)
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        method TEXT NOT NULL,
        address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    )

  ]);

}


// ==================================================
// USER
// ==================================================

async function ensureUser(db, userId) {

  userId =
    String(userId || "").trim();

  if (!userId) {
    throw new Error("Chýba ID používateľa.");
  }

  await db.prepare(
    INSERT OR IGNORE INTO users
    (id, bank_sats, mining_sats, created_at)
    VALUES (?, 0, 0, ?)
  )
  .bind(userId, now())
  .run();

}


async function getUser(db, userId) {

await ensureUser(
    db,
    userId
  );

  return await db.prepare(
    SELECT *
    FROM users
    WHERE id = ?
  )
  .bind(userId)
  .first();

}


// ==================================================
// MINING ACCRUAL
// ==================================================

async function accrueMining(db, userId) {

  const cycle =
    await db.prepare(
      SELECT *
      FROM mining_cycles
      WHERE user_id = ?
        AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    )
    .bind(userId)
    .first();

  if (!cycle) {
    return null;
  }

  const start =
    new Date(cycle.started_at)
      .getTime();

  const end =
    new Date(cycle.ends_at)
      .getTime();

  const current =
    Date.now();

  const effectiveNow =
    Math.min(current, end);

  const total =
    end - start;

  const elapsed =
    Math.max(
      0,
      effectiveNow - start
    );

  let progress =
    total > 0
      ? elapsed / total
      : 1;

  progress =
    Math.max(
      0,
      Math.min(1, progress)
    );

  const earned =
    Math.floor(
      cycle.principal_sats *
      cycle.rate *
      progress
    );

  return {
    cycle,
    earned,
    progress,
    finished:
      current >= end
  };

}


// ==================================================
// START MINING
// ==================================================

async function startMining(
  db,
  userId,
  days
) {

  days =
    Number(days);

  if (!ALLOWED_DAYS.includes(days)) {
    throw new Error(
      "Neplatná dĺžka Mining cyklu."
    );
  }

  await ensureUser(
    db,
    userId
  );

  const active =
    await db.prepare(
      SELECT *
      FROM mining_cycles
      WHERE user_id = ?
        AND status = 'active'
      LIMIT 1
    )
    .bind(userId)
    .first();

  if (active) {
    throw new Error(
      "Najprv musí skončiť aktuálny Mining cyklus."
    );
  }

  const user =
    await getUser(
      db,
      userId
    );

  const amount =
    Number(
      user.mining_sats || 0
    );

  if (amount < 1) {
    throw new Error(
      "V Mining nie sú žiadne satoshi."
    );
  }

  const rate =
    MINING_RATES[days];

  const started =
    new Date();

  const ends =
    new Date(
      started.getTime() +
      days *
      24 *
      60 *
      60 *
      1000
    );

  await db.batch([

    db.prepare(
      UPDATE users
      SET mining_sats = 0
      WHERE id = ?
    )
    .bind(userId),

    db.prepare(
      INSERT INTO mining_cycles
      (
        user_id,
        principal_sats,
        days,
        rate,
        started_at,
        ends_at,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    )
    .bind(
      userId,
      amount,
      days,
      rate,
      started.toISOString(),
      ends.toISOString()
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
      VALUES (?, 'MINING_START', ?, 0, ?, ?, ?)
    )
    .bind(
      userId,
      amount,
      -amount,
      "mining-start",
      now()
    )

  ]);

  return {
    days,
    principal_sats: amount,
    rate
  };

}


// ==================================================
// RELEASE MINING
// ==================================================

async function releaseMining(
  db,
  userId
) {

  const result =
    await accrueMining(
      db,
      userId
    );

  if (!result) {
    throw new Error(
      "Nemáš aktívny Mining cyklus."
    );
  }

  if (!result.finished) {

    throw new Error(
      "Mining cyklus ešte neskončil."
    );

  }

  const principal =
    Number(
      result.cycle.principal_sats
    );

  const earned =
    Number(
      result.earned
    );

  const total =
    principal + earned;

  await db.batch([

    db.prepare(
      UPDATE mining_cycles
      SET status = 'released',
          released_at = ?
      WHERE id = ?
        AND status = 'active'
    )
    .bind(
      now(),
      result.cycle.id
    ),

db.prepare(
      UPDATE users
      SET bank_sats = bank_sats + ?
      WHERE id = ?
    )
    .bind(
      total,
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
      VALUES (?, 'MINING_RELEASE', ?, ?, 0, ?, ?)
    )
    .bind(
      userId,
      total,
      total,
      "mining:" + result.cycle.id,
      now()
    )

  ]);

  return {
    principal_sats: principal,
    earned_sats: earned,
    total_sats: total
  };

}


// ==================================================
// BANK → MINING
// ==================================================

async function transferBankToMining(
  db,
  userId,
  amountSats
) {

  const amount =
    Math.floor(
      Number(amountSats)
    );

  if (
    !Number.isFinite(amount) ||
    amount < 1
  ) {
    throw new Error(
      "Neplatná suma."
    );
  }

  const user =
    await getUser(
      db,
      userId
    );

  if (
    Number(user.bank_sats) <
    amount
  ) {
    throw new Error(
      "V Bank nemáš dostatok satoshi."
    );
  }

  await db.batch([

    db.prepare(
      UPDATE users
      SET
        bank_sats = bank_sats - ?,
        mining_sats = mining_sats + ?
      WHERE id = ?
    )
    .bind(
      amount,
      amount,
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
      VALUES (?, 'BANK_TO_MINING', ?, ?, ?, ?, ?)
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


// ==================================================
// PTC REWARD
// ==================================================

async function addPtcReward(
  db,
  userId,
  provider,
  providerRef,
  amountSats
) {

  const amount =
    Math.floor(
      Number(amountSats)
    );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Neplatná PTC odmena."
    );
  }

  const bank =
    Math.floor(
      amount *
      PTC_BANK_SHARE
    );

  const mining =
    amount - bank;

  const ref =
    String(
      providerRef ||
      crypto.randomUUID()
    );

  try {

    await db.batch([

      db.prepare(
        INSERT INTO ptc_completions
        (
          user_id,
          provider,
          provider_ref,
          amount_sats,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      )
      .bind(
        userId,
        provider,
        ref,
        amount,
        now()
      ),

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
        amount,
        bank,
        mining,
        provider + ":" + ref,
        now()
      )

    ]);

  } catch (e) {

    if (
      String(e.message)
        .toLowerCase()
        .includes("unique")
    ) {
      return {
        duplicate: true
      };
    }

    throw e;

  }

  return {
    amount_sats: amount,
    bank_sats: bank,
    mining_sats: mining
  };

}


// ==================================================
// PROVIDER EARNING
// ==================================================

async function addProviderEarning(
  db,
  userId,
  provider,
  providerRef,
  amountSats
) {

  const amount =
    Math.floor(
      Number(amountSats)
    );

if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Neplatná suma poskytovateľa."
    );
  }

  const webShare =
    Math.floor(
      amount *
      PUBLISHER_WEB_SHARE
    );

  const userShare =
    amount - webShare;

  const ref =
    String(
      providerRef ||
      crypto.randomUUID()
    );

  try {

    await db.batch([

      db.prepare(
        INSERT INTO provider_earnings
        (
          provider,
          user_id,
          provider_ref,
          publisher_sats,
          web_sats,
          user_sats,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'paid', ?)
      )
      .bind(
        provider,
        userId,
        ref,
        amount,
        webShare,
        userShare,
        now()
      ),

      db.prepare(
        UPDATE users
        SET bank_sats = bank_sats + ?
        WHERE id = ?
      )
      .bind(
        amount,
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
        VALUES (?, 'PROVIDER_REWARD', ?, ?, 0, ?, ?)
      )
      .bind(
        userId,
        amount,
        amount,
        provider + ":" + ref,
        now()
      )

    ]);

  } catch (e) {

    if (
      String(e.message)
        .toLowerCase()
        .includes("unique")
    ) {

      return {
        duplicate: true
      };

    }

    throw e;

  }

  return {
    provider,
    publisher_sats: amount,
    web_sats: webShare,
    user_sats: userShare
  };

}


// ==================================================
// REFERRAL
// ==================================================

async function setReferral(
  db,
  userId,
  referrerId
) {

  userId =
    String(userId || "").trim();

  referrerId =
    String(referrerId || "").trim();

  if (
    !userId ||
    !referrerId
  ) {
    throw new Error(
      "Chýba referral ID."
    );
  }

  if (
    userId === referrerId
  ) {
    throw new Error(
      "Nemôžeš pozvať sám seba."
    );
  }

  await ensureUser(
    db,
    userId
  );

  await ensureUser(
    db,
    referrerId
  );

  const existing =
    await db.prepare(
      SELECT *
      FROM referrals
      WHERE user_id = ?
    )
    .bind(userId)
    .first();

  if (existing) {

    return {
      already_set: true,
      referrer_id:
        existing.referrer_id
    };

  }

  await db.prepare(
    INSERT INTO referrals
    (
      user_id,
      referrer_id,
      created_at
    )
    VALUES (?, ?, ?)
  )
  .bind(
    userId,
    referrerId,
    now()
  )
  .run();

  return {
    success: true,
    referrer_id: referrerId
  };

}


// ==================================================
// FAUCETPAY PAYOUT
// ==================================================

async function sendFaucetPay(
  env,
  withdrawalId,
  amountSats,
  address,
  request
) {

  if (!env.FAUCETPAY_API_KEY) {

    throw new Error(
      "V Cloudflare chýba secret FAUCETPAY_API_KEY."
    );

  }

  const idempotencyKey =
    "lili-withdraw-" +
    withdrawalId;


  const ip =
    request.headers.get(
      "CF-Connecting-IP"
    ) || "";


  const body = {
    idempotency_key:
      idempotencyKey,

    to:
      address,

    amount:
      Math.floor(
        Number(amountSats)
      ),

    currency:
      "BTC"
  };


  if (ip) {
    body.ip_address = ip;
  }


  const response =
    await fetch(
      "https://faucetpay.io/api/v2/send",
      {
        method: "POST",

        headers: {
          "Authorization":
            "Bearer " +
            env.FAUCETPAY_API_KEY,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );


  let data;

  try {

    data =
      await response.json();

  } catch {

    throw new Error(
      "FaucetPay vrátil neplatnú odpoveď."
    );

  }


  if (
    !response.ok ||
    data.success !== true
  ) {

throw new Error(
      data.message ||
      "FaucetPay výplata zlyhala."
    );

  }


  return data;

}


// ==================================================
// WITHDRAWAL
// ==================================================

async function createWithdrawal(
  db,
  env,
  userId,
  amountSats,
  method,
  address,
  request
) {

  const amount =
    Math.floor(
      Number(amountSats)
    );

  method =
    String(
      method || ""
    ).trim();

  address =
    String(
      address || ""
    ).trim();


  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL_SATS
  ) {
    throw new Error(
      "Minimálny výber je 100 sat."
    );
  }


  if (
    method !== "FaucetPay"
  ) {
    throw new Error(
      "Podporovaný spôsob výberu je FaucetPay."
    );
  }


  if (!address) {
    throw new Error(
      "Chýba FaucetPay používateľ alebo adresa."
    );
  }


  await ensureUser(
    db,
    userId
  );


  const user =
    await getUser(
      db,
      userId
    );


  if (
    Number(user.bank_sats) <
    amount
  ) {
    throw new Error(
      "V Bank nemáš dostatok satoshi."
    );
  }


  const processing =
    await db.prepare(
      SELECT id
      FROM withdrawals
      WHERE user_id = ?
        AND status = 'processing'
      LIMIT 1
    )
    .bind(userId)
    .first();


  if (processing) {

    throw new Error(
      "Už sa spracováva jeden výber. Počkaj na jeho dokončenie."
    );

  }


  const inserted =
    await db.prepare(
      INSERT INTO withdrawals
      (
        user_id,
        amount_sats,
        method,
        address,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, 'processing', ?)
    )
    .bind(
      userId,
      amount,
      method,
      address,
      now()
    )
    .run();


  const withdrawalId =
    inserted.meta.last_row_id;


  try {

    const payout =
      await sendFaucetPay(
        env,
        withdrawalId,
        amount,
        address,
        request
      );


    await db.batch([

      db.prepare(
        UPDATE users
        SET bank_sats = bank_sats - ?
        WHERE id = ?
          AND bank_sats >= ?
      )
      .bind(
        amount,
        userId,
        amount
      ),

      db.prepare(
        UPDATE withdrawals
        SET status = 'paid'
        WHERE id = ?
      )
      .bind(
        withdrawalId
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
        VALUES (?, 'WITHDRAWAL', ?, ?, 0, ?, ?)
      )
      .bind(
        userId,
        amount,
        -amount,
        "faucetpay:" +
          (
            payout.data &&
            payout.data.payout_id
              ? payout.data.payout_id
              : withdrawalId
          ),
        now()
      )

    ]);


    return {
      withdrawal_id:
        withdrawalId,

      amount_sats:
        amount,

      method:
        method,

      status:
        "paid",

      payout_id:
        payout.data &&
        payout.data.payout_id
          ? payout.data.payout_id
          : null
    };


  } catch (e) {

    await db.prepare(
      UPDATE withdrawals
      SET status = 'failed'
      WHERE id = ?
    )
    .bind(
      withdrawalId
    )
    .run();


    throw e;

  }

}


// ==================================================
// PROVIDER POSTBACK
// ==================================================

async function providerPostback(
  db,
  request,
  provider
) {

  let body = {};

  const contentType =
    request.headers.get(
      "content-type"
    ) || "";


  if (
    contentType.includes(
      "application/json"
    )
  ) {

    body =
      await readJson(
        request
      );

  } else {

    const form =
      await request.formData();

    for (
      const [key, value]
      of form.entries()
    ) {
      body[key] =
        String(value);
    }

  }

const userId =
    String(
      body.user_id ||
      body.userid ||
      body.uid ||
      body.subid ||
      OWNER_USER_ID
    ).trim();


  const providerRef =
    String(
      body.transaction_id ||
      body.transaction ||
      body.click_id ||
      body.clickid ||
      body.offer_id ||
      body.ref ||
      crypto.randomUUID()
    );


  let amount =
    Number(
      body.amount_sats ||
      body.sats ||
      body.amount
    );


  if (
    !Number.isFinite(amount)
  ) {

    return error(
      "Chýba suma odmeny.",
      400
    );

  }


  amount =
    Math.floor(
      amount
    );


  const result =
    await addProviderEarning(
      db,
      userId,
      provider,
      providerRef,
      amount
    );


  return json({
    ok: true,
    provider,
    user_id: userId,
    ...result
  });

}


// ==================================================
// STATE
// ==================================================

async function getState(
  db,
  userId
) {

  const user =
    await getUser(
      db,
      userId
    );


  const mining =
    await accrueMining(
      db,
      userId
    );


  return {
    ok: true,

    user: {
      id:
        user.id,

      bank_sats:
        Number(
          user.bank_sats || 0
        ),

      mining_sats:
        Number(
          user.mining_sats || 0
        )
    },

    mining_cycle:
      mining
        ? {
            id:
              mining.cycle.id,

            principal_sats:
              Number(
                mining.cycle
                  .principal_sats
              ),

            days:
              Number(
                mining.cycle.days
              ),

            rate:
              Number(
                mining.cycle.rate
              ),

            started_at:
              mining.cycle.started_at,

            ends_at:
              mining.cycle.ends_at,

            earned_sats:
              Number(
                mining.earned
              ),

            finished:
              mining.finished
          }
        : null
  };

}


// ==================================================
// ROUTER
// ==================================================

export default {

  async fetch(
    request,
    env
  ) {

    if (
      request.method ===
      "OPTIONS"
    ) {

      return json({
        ok: true
      });

    }


    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;


    try {

      if (!env.DB) {

        return error(
          "Cloudflare D1 binding DB nie je nastavený.",
          500
        );

      }


      await createTables(
        env.DB
      );


      // ------------------------------------------
      // STATE
      // ------------------------------------------

      if (
        path ===
        "/api/state" &&
        request.method ===
        "GET"
      ) {

        const userId =
          url.searchParams.get(
            "user_id"
          );

        if (!userId) {

          return error(
            "Chýba user_id."
          );

        }

        return json(
          await getState(
            env.DB,
            userId
          )
        );

      }


      // ------------------------------------------
      // REFERRAL
      // ------------------------------------------

      if (
        path ===
        "/api/referral/set" &&
        request.method ===
        "POST"
      ) {

        const body =
          await readJson(
            request
          );

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


      // ------------------------------------------
      // BANK → MINING
      // ------------------------------------------

      if (
        path ===
        "/api/bank/to-mining" &&
        request.method ===
        "POST"
      ) {

        const body =
          await readJson(
            request
          );

const result =
          await transferBankToMining(
            env.DB,
            body.user_id,
            body.amount_sats
          );

        return json({
          ok: true,
          ...result
        });

      }


      // ------------------------------------------
      // START MINING
      // ------------------------------------------

      if (
        path ===
        "/api/mining/start" &&
        request.method ===
        "POST"
      ) {

        const body =
          await readJson(
            request
          );

        const result =
          await startMining(
            env.DB,
            body.user_id,
            body.days
          );

        return json({
          ok: true,
          ...result
        });

      }


      // ------------------------------------------
      // RELEASE MINING
      // ------------------------------------------

      if (
        path ===
        "/api/mining/release" &&
        request.method ===
        "POST"
      ) {

        const body =
          await readJson(
            request
          );

        const result =
          await releaseMining(
            env.DB,
            body.user_id
          );

        return json({
          ok: true,
          ...result
        });

      }


      // ------------------------------------------
      // PTC REWARD
      // ------------------------------------------

      if (
        path ===
        "/api/ptc/reward" &&
        request.method ===
        "POST"
      ) {

        const body =
          await readJson(
            request
          );

        const result =
          await addPtcReward(
            env.DB,
            body.user_id,
            body.provider,
            body.provider_ref,
            body.amount_sats
          );

        return json({
          ok: true,
          ...result
        });

      }


      // ------------------------------------------
      // ADPARAGON
      // ------------------------------------------

      if (
        path ===
        "/api/postback/adparagon"
      ) {

        return await providerPostback(
          env.DB,
          request,
          "AdParagon"
        );

      }


      // ------------------------------------------
      // COINLYADS
      // ------------------------------------------

      if (
        path ===
        "/api/postback/coinlyads"
      ) {

        return await providerPostback(
          env.DB,
          request,
          "CoinlyAds"
        );

      }


      // ------------------------------------------
      // SPLITGRID
      // ------------------------------------------

      if (
        path ===
        "/api/postback/splitgrid"
      ) {

        return await providerPostback(
          env.DB,
          request,
          "SplitGrid"
        );

      }


      // ------------------------------------------
      // AoyCo
      // ------------------------------------------

      if (
        path ===
        "/api/postback/aoyco"
      ) {

        return await providerPostback(
          env.DB,
          request,
          "AoyCo"
        );

      }


      // ------------------------------------------
      // PROVIDER EARNINGS
      // ------------------------------------------

      if (
        path ===
        "/api/provider-earnings" &&
        request.method ===
        "GET"
      ) {

        const userId =
          url.searchParams.get(
            "user_id"
          );

        if (!userId) {

          return error(
            "Chýba user_id."
          );

        }


        const result =
          await env.DB.prepare(
            SELECT *
            FROM provider_earnings
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 100
          )
          .bind(userId)
          .all();


        return json({
          ok: true,
          earnings:
            result.results || []
        });

      }


      // ------------------------------------------
      // TRANSACTIONS
      // ------------------------------------------

if (
        path ===
        "/api/transactions" &&
        request.method ===
        "GET"
      ) {

        const userId =
          url.searchParams.get(
            "user_id"
          );

        if (!userId) {

          return error(
            "Chýba user_id."
          );

        }


        const result =
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
            result.results || []
        });

      }


      // ------------------------------------------
      // WITHDRAW
      // ------------------------------------------

      if (
        path ===
        "/api/withdraw" &&
        request.method ===
        "POST"
      ) {

        const body =
          await readJson(
            request
          );


        const result =
          await createWithdrawal(
            env.DB,
            env,
            body.user_id,
            body.amount_sats,
            body.method,
            body.address,
            request
          );


        return json({
          ok: true,
          ...result
        });

      }


      // ------------------------------------------
      // WITHDRAWALS
      // ------------------------------------------

      if (
        path ===
        "/api/withdrawals" &&
        request.method ===
        "GET"
      ) {

        const userId =
          url.searchParams.get(
            "user_id"
          );

        if (!userId) {

          return error(
            "Chýba user_id."
          );

        }


        const result =
          await env.DB.prepare(
            SELECT
              id,
              user_id,
              amount_sats,
              method,
              address,
              status,
              created_at
            FROM withdrawals
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 100
          )
          .bind(userId)
          .all();


        return json({
          ok: true,
          withdrawals:
            result.results || []
        });

      }


      return error(
        "Endpoint neexistuje.",
        404
      );


    } catch (e) {

      console.error(e);

      return error(
        e.message ||
        "Neznáma chyba servera.",
        500
      );

    }

  }

};
