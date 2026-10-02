Pata Hutira:
const OWNER = "lili";

const MIN_WITHDRAWAL = 100;

const PTC_BANK_SHARE = 0.50;
const PTC_MINING_SHARE = 0.50;

const WEB_SHARE = 0.95;
const USER_SHARE = 0.05;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const ALLOWED_DAYS = [1, 5, 10, 20, 30];

const PROVIDERS = [
  "adparagon",
  "coinlyads",
  "splitgrid",
  "aoyco",
  "octoclick"
];


// =====================================================
// RESPONSE
// =====================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Provider-Key"
      }
    }
  );
}

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function validUserId(value) {
  const id = clean(value).toLowerCase();

  if (!/^[a-z0-9_-]{3,32}$/.test(id)) {
    throw new Error("Neplatné ID používateľa.");
  }

  return id;
}

function rateFor(days) {
  return MINING_RATES[Number(days)] || 0;
}


// =====================================================
// PASSWORD
// =====================================================

async function hashPassword(password) {
  const bytes =
    new TextEncoder().encode(String(password ?? ""));

  const digest =
    await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}


// =====================================================
// DATABASE
// =====================================================

async function ensureSchema(db) {

  try {
    await db.prepare(
      "ALTER TABLE users ADD COLUMN password_hash TEXT"
    ).run();
  } catch (_) {}

  try {
    await db.prepare(
      "ALTER TABLE users ADD COLUMN is_registered INTEGER NOT NULL DEFAULT 0"
    ).run();
  } catch (_) {}

  await ensureUser(db, OWNER);

  try {
    await db.prepare(
      "UPDATE users SET is_registered = 1 WHERE id = ?"
    )
    .bind(OWNER)
    .run();
  } catch (_) {}
}


// =====================================================
// USER
// =====================================================

async function getUser(db, id) {
  return db.prepare(
    "SELECT * FROM users WHERE id = ?"
  )
  .bind(id)
  .first();
}

async function ensureUser(db, id) {

  id = validUserId(id);

  let user = await getUser(db, id);

  if (user) {
    return user;
  }

  await db.prepare(
    "INSERT INTO users " +
    "(id, bank_sats, mining_sats, created_at) " +
    "VALUES (?, 0, 0, ?)"
  )
  .bind(id, now())
  .run();

  return getUser(db, id);
}


// =====================================================
// REGISTER
// =====================================================

async function register(
  db,
  id,
  password,
  referrerId
) {

  id = validUserId(id);

  password = String(password || "");

  if (password.length < 6) {
    throw new Error(
      "Heslo musí mať minimálne 6 znakov."
    );
  }

  const existing = await getUser(db, id);

  if (
    existing &&
    Number(existing.is_registered || 0) === 1
  ) {
    throw new Error(
      "Tento účet už existuje."
    );
  }

  const passwordHash =
    await hashPassword(password);

  if (existing) {

    await db.prepare(
      "UPDATE users " +
      "SET password_hash = ?, " +
      "is_registered = 1 " +
      "WHERE id = ?"
    )
    .bind(passwordHash, id)
    .run();

  } else {

    await db.prepare(
      "INSERT INTO users " +
      "(id, bank_sats, mining_sats, created_at, " +
      "password_hash, is_registered) " +
      "VALUES (?, 0, 0, ?, ?, 1)"
    )
    .bind(id, now(), passwordHash)
    .run();
  }

  const ref =
    clean(referrerId).toLowerCase();

  if (
    ref &&
    ref !== id &&
    /^[a-z0-9_-]{3,32}$/.test(ref)
  ) {

    const refUser =
      await getUser(db, ref);

if (refUser) {

      const existingReferral =
        await db.prepare(
          "SELECT * FROM referrals WHERE user_id = ?"
        )
        .bind(id)
        .first();

      if (!existingReferral) {

        await db.prepare(
          "INSERT INTO referrals " +
          "(user_id, referrer_id, created_at) " +
          "VALUES (?, ?, ?)"
        )
        .bind(id, ref, now())
        .run();
      }
    }
  }

  return {
    user_id: id,
    registered: true
  };
}


// =====================================================
// LOGIN
// =====================================================

async function login(db, id, password) {

  id = validUserId(id);

  const user =
    await getUser(db, id);

  if (!user) {
    throw new Error("Účet neexistuje.");
  }

  if (
    Number(user.is_registered || 0) !== 1
  ) {
    throw new Error(
      "Účet ešte nie je registrovaný."
    );
  }

  const passwordHash =
    await hashPassword(password);

  if (
    passwordHash !== user.password_hash
  ) {
    throw new Error(
      "Nesprávne heslo."
    );
  }

  return {
    user_id: id,
    logged_in: true
  };
}


// =====================================================
// REFERRAL
// =====================================================

async function setReferral(
  db,
  userId,
  referrerId
) {

  userId = validUserId(userId);
  referrerId = validUserId(referrerId);

  if (userId === referrerId) {
    throw new Error(
      "Nemôžeš byť vlastným referralom."
    );
  }

  await ensureUser(db, userId);
  await ensureUser(db, referrerId);

  const old =
    await db.prepare(
      "SELECT * FROM referrals WHERE user_id = ?"
    )
    .bind(userId)
    .first();

  if (old) {
    return {
      user_id: userId,
      referrer_id: old.referrer_id,
      existing: true
    };
  }

  await db.prepare(
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


// =====================================================
// MINING ACCRUAL
// =====================================================

async function accrueMining(db, userId) {

  const result =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? AND status = 'active'"
    )
    .bind(userId)
    .all();

  for (const cycle of result.results || []) {

    const days =
      Number(cycle.duration_days);

    const rate =
      rateFor(days);

    if (!rate) continue;

    const elapsed =
      Math.min(
        days,
        Math.max(
          0,
          (
            Date.now() -
            new Date(cycle.started_at).getTime()
          ) / 86400000
        )
      );

    const target =
      Math.floor(
        Number(cycle.principal_sats || 0) *
        rate *
        (elapsed / days)
      );

    const already =
      Number(cycle.earned_sats || 0);

    const additional =
      Math.max(0, target - already);

    if (additional <= 0) {
      continue;
    }

    await db.batch([

      db.prepare(
        "UPDATE mining_cycles " +
        "SET earned_sats = earned_sats + ? " +
        "WHERE id = ?"
      )
      .bind(additional, cycle.id),

      db.prepare(
        "UPDATE users " +
        "SET mining_sats = mining_sats + ? " +
        "WHERE id = ?"
      )
      .bind(additional, userId),

      db.prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, " +
        "bank_change_sats, mining_change_sats, " +
        "reference, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        userId,
        "MINING_YIELD",
        additional,
        0,
        additional,
        "cycle:" + cycle.id,
        now()
      )
    ]);
  }
}


// =====================================================
// AUTO MINING -> BANK
// =====================================================

async function autoReleaseFinishedCycles(db) {

const result =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE status = 'active' " +
      "AND ends_at <= ? " +
      "ORDER BY id"
    )
    .bind(now())
    .all();

  for (const cycle of result.results || []) {

    const userId =
      cycle.user_id;

    await ensureUser(db, userId);

    await accrueMining(db, userId);

    const fresh =
      await db.prepare(
        "SELECT * FROM mining_cycles " +
        "WHERE id = ? AND status = 'active'"
      )
      .bind(cycle.id)
      .first();

    if (!fresh) continue;

    const principal =
      Number(fresh.principal_sats || 0);

    const earned =
      Number(fresh.earned_sats || 0);

    const total =
      principal + earned;

    await db.batch([

      db.prepare(
        "UPDATE users SET " +
        "bank_sats = bank_sats + ?, " +
        "mining_sats = MAX(0, mining_sats - ?) " +
        "WHERE id = ?"
      )
      .bind(total, earned, userId),

      db.prepare(
        "UPDATE mining_cycles " +
        "SET status = 'released', released_at = ? " +
        "WHERE id = ?"
      )
      .bind(now(), fresh.id),

      db.prepare(
        "INSERT INTO transactions " +
        "(user_id, type, amount_sats, " +
        "bank_change_sats, mining_change_sats, " +
        "reference, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        userId,
        "MINING_AUTO_RELEASE",
        total,
        total,
        -earned,
        "cycle:" + fresh.id,
        now()
      )
    ]);
  }
}


// =====================================================
// STATE
// =====================================================

async function getState(db, userId) {

  userId =
    validUserId(
      clean(userId) || OWNER
    );

  await ensureUser(db, userId);

  await autoReleaseFinishedCycles(db);

  await accrueMining(db, userId);

  const user =
    await getUser(db, userId);

  const cycles =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? " +
      "ORDER BY id DESC"
    )
    .bind(userId)
    .all();

  const referral =
    await db.prepare(
      "SELECT * FROM referrals " +
      "WHERE user_id = ?"
    )
    .bind(userId)
    .first();

  const providerTotals =
    await db.prepare(
      "SELECT " +
      "COALESCE(SUM(publisher_sats),0) AS publisher_sats, " +
      "COALESCE(SUM(web_sats),0) AS web_sats, " +
      "COALESCE(SUM(user_sats),0) AS user_sats " +
      "FROM provider_earnings " +
      "WHERE user_id = ? " +
      "AND status = 'confirmed'"
    )
    .bind(userId)
    .first();

  return {

    user_id: user.id,

    bank_sats:
      Number(user.bank_sats || 0),

    mining_sats:
      Number(user.mining_sats || 0),

    bank_btc:
      (
        Number(user.bank_sats || 0) /
        100000000
      ).toFixed(8),

    mining_btc:
      (
        Number(user.mining_sats || 0) /
        100000000
      ).toFixed(8),

    mining_rates:
      MINING_RATES,

    referral:
      referral || null,

    provider_totals: {

      publisher_sats:
        Number(
          providerTotals?.publisher_sats || 0
        ),

      web_sats:
        Number(
          providerTotals?.web_sats || 0
        ),

      user_sats:
        Number(
          providerTotals?.user_sats || 0
        )
    },

    cycles:
      cycles.results || []
  };
}


// =====================================================
// BANK -> MINING
// =====================================================

async function bankToMining(
  db,
  userId,
  amountSats
) {

  userId = validUserId(userId);

  const amount =
    Math.floor(Number(amountSats));

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error("Neplatná suma.");
  }

  await ensureUser(db, userId);

  const user =
    await getUser(db, userId);

  if (
    Number(user.bank_sats || 0) < amount
  ) {
    throw new Error(
      "V Banku nie je dostatok prostriedkov."
    );
  }

  await db.batch([

db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats - ?, " +
      "mining_sats = mining_sats + ? " +
      "WHERE id = ?"
    )
    .bind(amount, amount, userId),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      "BANK_TO_MINING",
      amount,
      -amount,
      amount,
      "bank-to-mining",
      now()
    )
  ]);

  return {
    amount_sats: amount,
    bank_sats:
      Number(user.bank_sats || 0) - amount,
    mining_sats:
      Number(user.mining_sats || 0) + amount
  };
}


// =====================================================
// START MINING
// =====================================================

async function startMining(
  db,
  userId,
  durationDays
) {

  userId = validUserId(userId);

  const days =
    Number(durationDays);

  if (!ALLOWED_DAYS.includes(days)) {
    throw new Error(
      "Povolené cykly: 1, 5, 10, 20 alebo 30 dní."
    );
  }

  await ensureUser(db, userId);

  await accrueMining(db, userId);

  const user =
    await getUser(db, userId);

  const amount =
    Number(user.mining_sats || 0);

  if (amount <= 0) {
    throw new Error(
      "Mining zostatok je 0."
    );
  }

  const startedAt =
    new Date();

  const endsAt =
    new Date(
      startedAt.getTime() +
      days * 86400000
    );

  const result =
    await db.prepare(
      "INSERT INTO mining_cycles " +
      "(user_id, principal_sats, started_at, " +
      "duration_days, ends_at, status, earned_sats) " +
      "VALUES (?, ?, ?, ?, ?, 'active', 0)"
    )
    .bind(
      userId,
      amount,
      startedAt.toISOString(),
      days,
      endsAt.toISOString()
    )
    .run();

  const cycleId =
    result.meta.last_row_id;

  await db.batch([

    db.prepare(
      "UPDATE users " +
      "SET mining_sats = 0 " +
      "WHERE id = ?"
    )
    .bind(userId),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      "MINING_START",
      amount,
      0,
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
    ends_at: endsAt.toISOString()
  };
}


// =====================================================
// MINING -> BANK
// =====================================================

async function releaseMining(
  db,
  userId,
  cycleId
) {

  userId = validUserId(userId);

  const id =
    Number(cycleId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Neplatné ID mining cyklu."
    );
  }

  await ensureUser(db, userId);

  await accrueMining(db, userId);

  const cycle =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE id = ? AND user_id = ?"
    )
    .bind(id, userId)
    .first();

  if (!cycle) {
    throw new Error(
      "Mining cyklus neexistuje."
    );
  }

  if (cycle.status !== "active") {
    throw new Error(
      "Mining cyklus už bol presunutý."
    );
  }

  if (
    new Date(cycle.ends_at).getTime() >
    Date.now()
  ) {
    throw new Error(
      "Mining cyklus ešte neskončil."
    );
  }

  const principal =
    Number(cycle.principal_sats || 0);

  const earned =
    Number(cycle.earned_sats || 0);

  const total =
    principal + earned;

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ?, " +
      "mining_sats = MAX(0, mining_sats - ?) " +
      "WHERE id = ?"
    )
    .bind(total, earned, userId),

    db.prepare(
      "UPDATE mining_cycles " +
      "SET status = 'released', released_at = ? " +
      "WHERE id = ?"
    )
    .bind(now(), id),

db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      "MINING_RELEASE",
      total,
      total,
      -earned,
      "cycle:" + id,
      now()
    )
  ]);

  return {
    cycle_id: id,
    released_sats: total
  };
}


// =====================================================
// PTC
// =====================================================

async function addPtcReward(
  db,
  userId,
  offerId,
  rewardSats,
  providerRef
) {

  userId = validUserId(userId);

  const offer =
    clean(offerId) || "ptc";

  const reward =
    Math.floor(Number(rewardSats));

  if (
    !Number.isFinite(reward) ||
    reward <= 0
  ) {
    throw new Error(
      "Neplatná PTC odmena."
    );
  }

  await ensureUser(db, userId);

  if (providerRef) {

    const duplicate =
      await db.prepare(
        "SELECT id FROM ptc_completions " +
        "WHERE provider_ref = ? LIMIT 1"
      )
      .bind(clean(providerRef))
      .first();

    if (duplicate) {
      return {
        duplicate: true,
        completion_id: duplicate.id
      };
    }
  }

  const bank =
    Math.floor(
      reward * PTC_BANK_SHARE
    );

  const mining =
    reward - bank;

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ?, " +
      "mining_sats = mining_sats + ? " +
      "WHERE id = ?"
    )
    .bind(bank, mining, userId),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      "PTC_REWARD",
      reward,
      bank,
      mining,
      offer,
      now()
    ),

    db.prepare(
      "INSERT INTO ptc_completions " +
      "(user_id, offer_id, reward_sats, " +
      "provider_ref, created_at) " +
      "VALUES (?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      offer,
      reward,
      providerRef
        ? clean(providerRef)
        : null,
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


// =====================================================
// PROVIDER EARNING
// =====================================================

async function addProviderEarning(
  db,
  provider,
  userId,
  providerRef,
  publisherSats
) {

  provider =
    clean(provider).toLowerCase();

  userId =
    validUserId(userId);

  providerRef =
    clean(providerRef);

  if (!PROVIDERS.includes(provider)) {
    throw new Error(
      "Nepodporovaný provider."
    );
  }

  const amount =
    Math.floor(Number(publisherSats));

  if (!providerRef) {
    throw new Error(
      "Chýba provider_ref."
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

  const duplicate =
    await db.prepare(
      "SELECT id FROM provider_earnings " +
      "WHERE provider = ? " +
      "AND provider_ref = ? " +
      "LIMIT 1"
    )
    .bind(provider, providerRef)
    .first();

  if (duplicate) {
    return {
      duplicate: true,
      earning_id: duplicate.id
    };
  }

  const webSats =
    Math.floor(
      amount * WEB_SHARE
    );

  const userSats =
    amount - webSats;

  await db.batch([

    db.prepare(
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

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ? " +
      "WHERE id = ?"
    )
    .bind(webSats, OWNER),

db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ? " +
      "WHERE id = ?"
    )
    .bind(userSats, userId),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      OWNER,
      "PROVIDER_WEB_EARNING",
      webSats,
      webSats,
      0,
      provider + ":" + providerRef,
      now()
    )
  ]);

  if (
    userSats > 0 &&
    userId !== OWNER
  ) {

    await db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      "PROVIDER_USER_REWARD",
      userSats,
      userSats,
      0,
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


// =====================================================
// REQUEST BODY
// =====================================================

async function readBody(request) {

  const contentType =
    request.headers.get("content-type") || "";

  if (
    contentType.includes("application/json")
  ) {
    return await request.json();
  }

  const form =
    await request.formData();

  const body = {};

  for (
    const [key, value]
    of form.entries()
  ) {
    body[key] = String(value);
  }

  return body;
}


// =====================================================
// PROVIDER SECURITY
// =====================================================

function checkProviderKey(request, env) {

  /*
   * Ak nastavíš v Cloudflare Worker Secrets:
   *
   * PROVIDER_SECRET
   *
   * provider postback musí poslať:
   *
   * X-Provider-Key: tvoje_tajne_heslo
   *
   * Ak secret zatiaľ nemáš nastavený,
   * postback zostane kompatibilný
   * s doterajším nastavením.
   */

  const secret =
    clean(env.PROVIDER_SECRET);

  if (!secret) {
    return true;
  }

  const supplied =
    clean(
      request.headers.get(
        "X-Provider-Key"
      )
    );

  return supplied === secret;
}


// =====================================================
// PROVIDER POSTBACK
// =====================================================

async function providerPostback(
  db,
  provider,
  request,
  env
) {

  if (!checkProviderKey(request, env)) {

    return json(
      {
        ok: false,
        error:
          "Neplatný provider key."
      },
      401
    );
  }

  const body =
    await readBody(request);

  const userId =
    body.user_id ||
    body.user ||
    body.uid ||
    body.sub_id;

  const providerRef =
    body.provider_ref ||
    body.transaction_id ||
    body.transaction ||
    body.txid ||
    body.click_id ||
    body.ref;

  const amount =
    body.publisher_sats ??
    body.earn_sats ??
    body.reward_sats ??
    body.sats ??
    body.payout;

  if (!userId) {
    return json(
      {
        ok: false,
        error:
          "Chýba user_id."
      },
      400
    );
  }

  if (!providerRef) {
    return json(
      {
        ok: false,
        error:
          "Chýba provider transaction/reference."
      },
      400
    );
  }

  if (
    !Number.isFinite(Number(amount)) ||
    Number(amount) <= 0
  ) {
    return json(
      {
        ok: false,
        error:
          "Chýba platný publisher príjem v sats."
      },
      400
    );
  }

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


// =====================================================
// WITHDRAWAL
// =====================================================

async function requestWithdrawal(
  db,
  userId,
  amountSats,
  method,
  address
) {

  userId =
    validUserId(userId);

const amount =
    Math.floor(Number(amountSats));

  const payoutMethod =
    clean(method) || "FaucetPay";

  const payoutAddress =
    clean(address);

  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL
  ) {
    throw new Error(
      Minimum výberu je ${MIN_WITHDRAWAL} sats.
    );
  }

  if (!payoutAddress) {
    throw new Error(
      "Zadaj cieľ výplaty."
    );
  }

  await ensureUser(db, userId);

  const user =
    await getUser(db, userId);

  if (
    Number(user.bank_sats || 0) <
    amount
  ) {
    throw new Error(
      "V Banku nie je dostatok prostriedkov."
    );
  }

  const result =
    await db.prepare(
      "INSERT INTO withdrawals " +
      "(user_id, amount_sats, method, " +
      "address, status, created_at) " +
      "VALUES (?, ?, ?, ?, 'pending', ?)"
    )
    .bind(
      userId,
      amount,
      payoutMethod,
      payoutAddress,
      now()
    )
    .run();

  const withdrawalId =
    result.meta.last_row_id;

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats - ? " +
      "WHERE id = ?"
    )
    .bind(amount, userId),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      userId,
      "WITHDRAWAL_PENDING",
      amount,
      -amount,
      0,
      "withdrawal:" + withdrawalId,
      now()
    )
  ]);

  return {
    withdrawal_id: withdrawalId,
    amount_sats: amount,
    method: payoutMethod,
    status: "pending"
  };
}


// =====================================================
// TRANSACTION HISTORY
// =====================================================

async function getTransactions(
  db,
  userId
) {

  userId =
    validUserId(userId);

  const result =
    await db.prepare(
      "SELECT id, type, amount_sats, " +
      "bank_change_sats, mining_change_sats, " +
      "reference, created_at " +
      "FROM transactions " +
      "WHERE user_id = ? " +
      "ORDER BY id DESC " +
      "LIMIT 100"
    )
    .bind(userId)
    .all();

  return result.results || [];
}


// =====================================================
// PROVIDER HISTORY
// =====================================================

async function getProviderEarnings(
  db,
  userId
) {

  userId =
    validUserId(userId);

  const result =
    await db.prepare(
      "SELECT id, provider, provider_ref, " +
      "publisher_sats, web_sats, user_sats, " +
      "status, created_at " +
      "FROM provider_earnings " +
      "WHERE user_id = ? " +
      "ORDER BY id DESC " +
      "LIMIT 100"
    )
    .bind(userId)
    .all();

  return result.results || [];
}


// =====================================================
// ROUTER
// =====================================================

async function route(request, env) {

  if (!env.DB) {

    return json(
      {
        ok: false,
        error:
          "Cloudflare D1 binding DB nie je nastavený."
      },
      500
    );
  }

  await ensureSchema(env.DB);

  const url =
    new URL(request.url);

  const path =
    url.pathname;

  const method =
    request.method.toUpperCase();


  // OPTIONS
  if (method === "OPTIONS") {
    return json({ ok: true });
  }


  // HEALTH
  if (
    method === "GET" &&
    path === "/"
  ) {

    return json({
      ok: true,
      status: "online",
      version: "4.1.0",
      service: "Lili Faucet Worker"
    });
  }


  // STATE
  if (
    method === "GET" &&
    path === "/api/state"
  ) {

    return json({
      ok: true,
      ...(await getState(
        env.DB,
        url.searchParams.get("user_id") || OWNER
      ))
    });
  }


  // REGISTER
  if (
    method === "POST" &&
    path === "/api/register"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await register(
        env.DB,
        body.user_id,
        body.password,
        body.referrer_id || body.ref
      ))
    });
  }

// LOGIN
  if (
    method === "POST" &&
    path === "/api/login"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await login(
        env.DB,
        body.user_id,
        body.password
      ))
    });
  }


  // REFERRAL
  if (
    method === "POST" &&
    path === "/api/referral"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await setReferral(
        env.DB,
        body.user_id,
        body.referrer_id
      ))
    });
  }


  // BANK -> MINING
  if (
    method === "POST" &&
    path === "/api/bank/to-mining"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await bankToMining(
        env.DB,
        body.user_id,
        body.amount_sats
      ))
    });
  }


  // START MINING
  if (
    method === "POST" &&
    path === "/api/mining/start"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await startMining(
        env.DB,
        body.user_id,
        body.duration_days
      ))
    });
  }


  // RELEASE MINING
  if (
    method === "POST" &&
    path === "/api/mining/release"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await releaseMining(
        env.DB,
        body.user_id,
        body.cycle_id
      ))
    });
  }


  // PTC
  if (
    method === "POST" &&
    path === "/api/ptc/reward"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await addPtcReward(
        env.DB,
        body.user_id,
        body.offer_id,
        body.reward_sats,
        body.provider_ref
      ))
    });
  }


  // PROVIDERS
  if (
    method === "POST" &&
    path.startsWith("/api/provider/")
  ) {

    const provider =
      path
        .slice("/api/provider/".length)
        .toLowerCase();

    return await providerPostback(
      env.DB,
      provider,
      request,
      env
    );
  }


  // GENERIC PROVIDER
  if (
    method === "POST" &&
    path === "/api/provider-earning"
  ) {

    if (!checkProviderKey(request, env)) {

      return json(
        {
          ok: false,
          error:
            "Neplatný provider key."
        },
        401
      );
    }

    const body =
      await readBody(request);

    const result =
      await addProviderEarning(
        env.DB,
        body.provider,
        body.user_id,
        body.provider_ref,
        body.publisher_sats
      );

    return json({
      ok: true,
      ...result
    });
  }


  // WITHDRAW
  if (
    method === "POST" &&
    path === "/api/withdraw"
  ) {

    const body =
      await readBody(request);

    return json({
      ok: true,
      ...(await requestWithdrawal(
        env.DB,
        body.user_id,
        body.amount_sats,
        body.method ||
          body.provider ||
          "FaucetPay",
        body.address
      ))
    });
  }


  // TRANSACTIONS
  if (
    method === "GET" &&
    path === "/api/transactions"
  ) {

    return json({
      ok: true,
      transactions:
        await getTransactions(
          env.DB,
          url.searchParams.get("user_id") || OWNER
        )
    });
  }


  // PROVIDER HISTORY
  if (
    method === "GET" &&
    path === "/api/provider-earnings"
  ) {

    return json({
      ok: true,
      earnings:
        await getProviderEarnings(
          env.DB,
          url.searchParams.get("user_id") || OWNER
        )
    });
  }


  // 404
  return json(
    {
      ok: false,
      error: "Endpoint neexistuje."
    },
    404
  );
}


// =====================================================
// CLOUDFLARE WORKER
// =====================================================

export default {

  async fetch(request, env, ctx) {

    try {

      return await route(
        request,
        env
      );

    } catch (error) {

      console.error(
        "Worker error:",
        error
      );

return json(
        {
          ok: false,
          error:
            error?.message ||
            "Interná chyba servera."
        },
        400
      );
    }
  },


  async scheduled(
    event,
    env,
    ctx
  ) {

    if (!env.DB) {
      return;
    }

    ctx.waitUntil(

      (async () => {

        await ensureSchema(
          env.DB
        );

        await autoReleaseFinishedCycles(
          env.DB
        );

      })()

    );
  }

};
