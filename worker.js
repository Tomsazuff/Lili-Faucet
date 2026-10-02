
const OWNER = "lili";
const MIN_WITHDRAW = 100;

const API_ORIGIN = "https://ancient-mud-7b85.pazuriktomo.workers.dev";

const PROVIDERS = {
  aoyco: {
    name: "Aoyco",
    shareBank: 0.95,
    shareReferral: 0.05
  },
  octoclick: {
    name: "OctoClick",
    shareBank: 0.95,
    shareReferral: 0.05
  }
};

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization"
    }
  });
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "Content-Type, Authorization");
  return new Response(response.body, {
    status: response.status,
    headers: h
  });
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function token() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

function now() {
  return Date.now();
}

function miningRate(days) {
  return MINING_RATES[Number(days)] || 0;
}

async function schema(db) {
  await db.prepare(
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      password_hash TEXT,
      bank_sats INTEGER DEFAULT 0,
      mining_sats INTEGER DEFAULT 0,
      is_registered INTEGER DEFAULT 0,
      created_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER,
      expires_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL UNIQUE,
      created_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS mining_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      principal_sats INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      rate REAL NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      released INTEGER DEFAULT 0,
      created_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      description TEXT,
      created_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS provider_earnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      user_id TEXT,
      gross_sats INTEGER NOT NULL,
      bank_sats INTEGER NOT NULL,
      referral_sats INTEGER NOT NULL,
      created_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      method TEXT,
      address TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER
    )
  ).run();

  await db.prepare(
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  ).run();

  await db.prepare(
    INSERT OR IGNORE INTO settings (key,value)
    VALUES ('owner','${OWNER}')
  ).run();

await db.prepare(
    INSERT OR IGNORE INTO users
    (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at)
    VALUES (?,?,?,?,?,?,?)
  )
    .bind(
      OWNER,
      "",
      "",
      0,
      0,
      1,
      now()
    )
    .run();
}

async function getUser(db, id) {
  return await db
    .prepare("SELECT * FROM users WHERE id=?")
    .bind(id)
    .first();
}

async function createSession(db, userId) {
  const t = token();
  const expires = now() + 1000 * 60 * 60 * 24 * 30;

  await db.prepare(
    INSERT INTO sessions
    (token,user_id,created_at,expires_at)
    VALUES (?,?,?,?)
  )
    .bind(t, userId, now(), expires)
    .run();

  return t;
}

async function auth(request, db) {
  const header = request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const t = header.slice(7).trim();

  if (!t) {
    return null;
  }

  const session = await db.prepare(
    SELECT s.*,u.*
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at>?
  )
    .bind(t, now())
    .first();

  return session || null;
}

async function ensureUser(db, id) {
  let user = await getUser(db, id);

  if (!user) {
    await db.prepare(
      INSERT INTO users
      (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at)
      VALUES (?,?,?,?,?,?,?)
    )
      .bind(
        id,
        "",
        "",
        0,
        0,
        id === OWNER ? 1 : 0,
        now()
      )
      .run();

    user = await getUser(db, id);
  }

  return user;
}

async function accrueMining(db, cycle) {
  if (!cycle || Number(cycle.released) === 1) {
    return cycle;
  }

  const current = now();

  if (current < Number(cycle.start_at)) {
    return cycle;
  }

  const end = Number(cycle.end_at);
  const start = Number(cycle.start_at);
  const effective = Math.min(current, end);

  const totalSeconds = Math.max(1, end - start);
  const elapsed = Math.max(0, effective - start);

  const progress = Math.min(1, elapsed / totalSeconds);

  const fullProfit = Math.floor(
    Number(cycle.principal_sats) * Number(cycle.rate)
  );

  const earned = Math.floor(fullProfit * progress);

  return {
    ...cycle,
    earned_sats: earned,
    progress
  };
}

async function releaseFinished(db) {
  const rows = await db.prepare(
    SELECT *
    FROM mining_cycles
    WHERE released=0 AND end_at<=?
  )
    .bind(now())
    .all();

  for (const cycle of rows.results || []) {
    const profit = Math.floor(
      Number(cycle.principal_sats) * Number(cycle.rate)
    );

    const total = Number(cycle.principal_sats) + profit;

    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    )
      .bind(total, cycle.user_id)
      .run();

    await db.prepare(
      UPDATE mining_cycles
      SET released=1
      WHERE id=? AND released=0
    )
      .bind(cycle.id)
      .run();

    await db.prepare(
      INSERT INTO transactions
      (user_id,type,amount_sats,description,created_at)
      VALUES (?,?,?,?,?)
    )
      .bind(
        cycle.user_id,
        "mining_release",
        total,
        Mining ${cycle.duration_days} dní: vklad ${cycle.principal_sats} sat + zisk ${profit} sat,
        now()
      )
      .run();
  }
}

async function register(db, data) {
  const id = String(data.user_id || "").trim().toLowerCase();
  const email = String(data.email || "").trim().toLowerCase();
  const password = String(data.password || "");
  const referrer = String(data.referrer_id || "").trim().toLowerCase();

  if (!id || id.length < 3) {
    return json({ error: "Používateľské meno musí mať aspoň 3 znaky." }, 400);
  }

  if (!email || !email.includes("@")) {
    return json({ error: "Zadaj platný email." }, 400);
  }

  if (password.length < 6) {
    return json({ error: "Heslo musí mať aspoň 6 znakov." }, 400);
  }

  if (id === OWNER) {
    return json({ error: "Toto používateľské meno je rezervované." }, 400);
  }

  const existing = await getUser(db, id);

if (existing && Number(existing.is_registered) === 1) {
    return json({ error: "Používateľ už existuje." }, 409);
  }

  const passwordHash = await hashPassword(password);

  if (existing) {
    await db.prepare(
      UPDATE users
      SET email=?,password_hash=?,is_registered=1
      WHERE id=?
    )
      .bind(email, passwordHash, id)
      .run();
  } else {
    await db.prepare(
      INSERT INTO users
      (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at)
      VALUES (?,?,?,?,?,?,?)
    )
      .bind(
        id,
        email,
        passwordHash,
        0,
        0,
        1,
        now()
      )
      .run();
  }

  if (referrer && referrer !== id) {
    const refUser = await getUser(db, referrer);

    const validReferrer =
      refUser &&
      (
        Number(refUser.is_registered) === 1 ||
        referrer === OWNER
      );

    if (validReferrer) {
      await db.prepare(
        INSERT OR IGNORE INTO referrals
        (referrer_id,referred_id,created_at)
        VALUES (?,?,?)
      )
        .bind(referrer, id, now())
        .run();
    }
  }

  const session = await createSession(db, id);

  return json({
    ok: true,
    user_id: id,
    token: session
  });
}

async function login(db, data) {
  const loginValue = String(data.login || "").trim().toLowerCase();
  const password = String(data.password || "");

  if (!loginValue || !password) {
    return json({ error: "Vyplň prihlasovacie údaje." }, 400);
  }

  const user = await db.prepare(
    SELECT *
    FROM users
    WHERE id=? OR email=?
    LIMIT 1
  )
    .bind(loginValue, loginValue)
    .first();

  if (!user || Number(user.is_registered) !== 1) {
    return json({ error: "Nesprávne prihlasovacie údaje." }, 401);
  }

  const passwordHash = await hashPassword(password);

  if (passwordHash !== user.password_hash) {
    return json({ error: "Nesprávne prihlasovacie údaje." }, 401);
  }

  const session = await createSession(db, user.id);

  return json({
    ok: true,
    user_id: user.id,
    token: session
  });
}

async function state(db, userId) {
  const user = await getUser(db, userId);

  const active = await db.prepare(
    SELECT *
    FROM mining_cycles
    WHERE user_id=? AND released=0
    ORDER BY id DESC
  )
    .bind(userId)
    .all();

  const cycles = [];

  for (const c of active.results || []) {
    cycles.push(await accrueMining(db, c));
  }

  return json({
    ok: true,
    user_id: user.id,
    bank_sats: Number(user.bank_sats || 0),
    mining_sats: Number(user.mining_sats || 0),
    mining: cycles,
    min_withdraw: MIN_WITHDRAW,
    mining_rates: MINING_RATES
  });
}

async function bankToMining(db, userId, data) {
  const amount = Math.floor(Number(data.amount_sats || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "Neplatná suma." }, 400);
  }

  const result = await db.prepare(
    UPDATE users
    SET bank_sats=bank_sats-?,
        mining_sats=mining_sats+?
    WHERE id=? AND bank_sats>=?
  )
    .bind(amount, amount, userId, amount)
    .run();

  if (!result.meta  Number(result.meta.changes  0) !== 1) {
    return json({ error: "Na Banku nemáš dostatok satoshi." }, 400);
  }

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES (?,?,?,?,?)
  )
    .bind(
      userId,
      "bank_to_mining",
      amount,
      "Presun z Bank do Mining",
      now()
    )
    .run();

  return json({
    ok: true,
    amount_sats: amount
  });
}

async function startMining(db, userId, data) {
  const days = Number(data.duration_days);
  const rate = miningRate(days);

  if (!rate) {
    return json({ error: "Neplatná dĺžka miningu." }, 400);
  }

  const user = await getUser(db, userId);
  const amount = Number(user.mining_sats || 0);

  if (amount <= 0) {
    return json({
      error: "Najskôr presuň satoshi z Bank do Mining."
    }, 400);
  }

  const start = now();
  const end = start + days * 24 * 60 * 60 * 1000;

await db.prepare(
    UPDATE users
    SET mining_sats=0
    WHERE id=? AND mining_sats=?
  )
    .bind(userId, amount)
    .run();

  await db.prepare(
    INSERT INTO mining_cycles
    (user_id,principal_sats,duration_days,rate,start_at,end_at,released,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  )
    .bind(
      userId,
      amount,
      days,
      rate,
      start,
      end,
      0,
      now()
    )
    .run();

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES (?,?,?,?,?)
  )
    .bind(
      userId,
      "mining_start",
      amount,
      Spustený mining na ${days} dní,
      now()
    )
    .run();

  const profit = Math.floor(amount * rate);

  return json({
    ok: true,
    principal_sats: amount,
    profit_sats: profit,
    total_sats: amount + profit,
    duration_days: days,
    rate
  });
}

async function referrals(db, userId) {
  const rows = await db.prepare(
    SELECT referred_id,created_at
    FROM referrals
    WHERE referrer_id=?
    ORDER BY id DESC
  )
    .bind(userId)
    .all();

  return json({
    ok: true,
    referral_id: userId,
    referral_link:
      API_ORIGIN.replace(
        "ancient-mud-7b85.pazuriktomo.workers.dev",
        ""
      ) +
      "?ref=" +
      encodeURIComponent(userId),
    count: (rows.results || []).length,
    referrals: rows.results || []
  });
}

async function transactions(db, userId) {
  const rows = await db.prepare(
    SELECT id,type,amount_sats,description,created_at
    FROM transactions
    WHERE user_id=?
    ORDER BY id DESC
    LIMIT 200
  )
    .bind(userId)
    .all();

  return json({
    ok: true,
    transactions: rows.results || []
  });
}

async function withdraw(db, userId, data) {
  const amount = Math.floor(Number(data.amount_sats || 0));
  const method = String(data.method || "FaucetPay").trim();
  const address = String(data.address || "").trim();

  if (!Number.isFinite(amount) || amount < MIN_WITHDRAW) {
    return json({
      error: Minimum výber je ${MIN_WITHDRAW} sat.
    }, 400);
  }

  if (!address) {
    return json({
      error: "Zadaj BTC/FaucetPay adresu."
    }, 400);
  }

  const result = await db.prepare(
    UPDATE users
    SET bank_sats=bank_sats-?
    WHERE id=? AND bank_sats>=?
  )
    .bind(amount, userId, amount)
    .run();

  if (!result.meta  Number(result.meta.changes  0) !== 1) {
    return json({
      error: "Na Banku nemáš dostatok satoshi."
    }, 400);
  }

  await db.prepare(
    INSERT INTO withdrawals
    (user_id,amount_sats,method,address,status,created_at)
    VALUES (?,?,?,?,?,?)
  )
    .bind(
      userId,
      amount,
      method,
      address,
      "pending",
      now()
    )
    .run();

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES (?,?,?,?,?)
  )
    .bind(
      userId,
      "withdraw",
      amount,
      Výber ${method}: ${address},
      now()
    )
    .run();

  return json({
    ok: true,
    status: "pending",
    amount_sats: amount,
    message:
      "Výber bol prijatý a čaká na spracovanie."
  });
}

async function providerPostback(request, db, provider) {
  const secret = request.headers.get("X-Provider-Secret") || "";

  if (
    !request.env.PROVIDER_SECRET ||
    secret !== request.env.PROVIDER_SECRET
  ) {
    return json({ error: "Unauthorized provider request." }, 401);
  }

  const data = await body(request);

  const gross = Math.floor(
    Number(
      data.amount_sats ??
      data.amount ??
      data.reward ??
      0
    )
  );

  const userId = String(
    data.user_id ??
    data.username ??
    ""
  )
    .trim()
    .toLowerCase();

  if (!userId  !Number.isFinite(gross)  gross <= 0) {
    return json({
      error: "Neplatný provider postback."
    }, 400);
  }

  const user = await getUser(db, userId);

  if (!user || Number(user.is_registered) !== 1) {
    return json({
      error: "Používateľ neexistuje."
    }, 404);
  }

const bankShare = Math.floor(
    gross * PROVIDERS[provider].shareBank
  );

  const referralShare = gross - bankShare;

  await db.prepare(
    UPDATE users
    SET bank_sats=bank_sats+?
    WHERE id=?
  )
    .bind(bankShare, userId)
    .run();

  const referral = await db.prepare(
    SELECT referrer_id
    FROM referrals
    WHERE referred_id=?
    LIMIT 1
  )
    .bind(userId)
    .first();

  if (referral && referral.referrer_id) {
    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    )
      .bind(referralShare, referral.referrer_id)
      .run();

    await db.prepare(
      INSERT INTO transactions
      (user_id,type,amount_sats,description,created_at)
      VALUES (?,?,?,?,?)
    )
      .bind(
        referral.referrer_id,
        "referral",
        referralShare,
        Referral od ${provider},
        now()
      )
      .run();
  } else {
    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    )
      .bind(referralShare, OWNER)
      .run();
  }

  await db.prepare(
    INSERT INTO provider_earnings
    (provider,user_id,gross_sats,bank_sats,referral_sats,created_at)
    VALUES (?,?,?,?,?,?)
  )
    .bind(
      provider,
      userId,
      gross,
      bankShare,
      referralShare,
      now()
    )
    .run();

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES (?,?,?,?,?)
  )
    .bind(
      userId,
      "provider",
      bankShare,
      ${PROVIDERS[provider].name} odmena,
      now()
    )
    .run();

  return json({
    ok: true,
    provider,
    gross_sats: gross,
    bank_sats: bankShare,
    referral_sats: referralShare
  });
}

async function providerInfo() {
  return json({
    ok: true,
    providers: [
      {
        id: "aoyco",
        name: "Aoyco",
        bank_percent: 95,
        referral_percent: 5
      },
      {
        id: "octoclick",
        name: "OctoClick",
        bank_percent: 95,
        referral_percent: 5
      }
    ]
  });
}

async function route(request, env) {
  const db = env.DB;

  if (!db) {
    return json({
      error: "D1 binding DB nie je nastavený."
    }, 500);
  }

  await schema(db);
  await releaseFinished(db);

  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  if (path === "/") {
    return json({
      ok: true,
      name: "Lili Faucet",
      status: "online"
    });
  }

  if (
    path === "/api/provider/aoyco" &&
    request.method === "POST"
  ) {
    return providerPostback(request, db, "aoyco");
  }

  if (
    path === "/api/provider/octoclick" &&
    request.method === "POST"
  ) {
    return providerPostback(request, db, "octoclick");
  }

  if (
    path === "/api/providers" &&
    request.method === "GET"
  ) {
    return providerInfo();
  }

  if (
    path === "/api/register" &&
    request.method === "POST"
  ) {
    return register(db, await body(request));
  }

  if (
    path === "/api/login" &&
    request.method === "POST"
  ) {
    return login(db, await body(request));
  }

  const user = await auth(request, db);

  if (!user) {
    return json({
      error: "Nie si prihlásený."
    }, 401);
  }

  if (
    path === "/api/state" &&
    request.method === "GET"
  ) {
    return state(db, user.id);
  }

  if (
    path === "/api/bank/to-mining" &&
    request.method === "POST"
  ) {
    return bankToMining(
      db,
      user.id,
      await body(request)
    );
  }

  if (
    path === "/api/mining/start" &&
    request.method === "POST"
  ) {
    return startMining(
      db,
      user.id,
      await body(request)
    );
  }

  if (
    path === "/api/referrals" &&
    request.method === "GET"
  ) {
    return referrals(db, user.id);
  }

  if (
    path === "/api/transactions" &&
    request.method === "GET"
  ) {
    return transactions(db, user.id);
  }

if (
    path === "/api/withdraw" &&
    request.method === "POST"
  ) {
    return withdraw(
      db,
      user.id,
      await body(request)
    );
  }

  if (path === "/api/logout") {
    const header =
      request.headers.get("Authorization") || "";

    if (header.startsWith("Bearer ")) {
      const t = header.slice(7).trim();

      await db.prepare(
        DELETE FROM sessions
        WHERE token=?
      )
        .bind(t)
        .run();
    }

    return json({ ok: true });
  }

  return json({
    error: "Endpoint neexistuje."
  }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      return cors(response);
    } catch (error) {
      return json({
        error: "Worker chyba.",
        detail: String(error?.message || error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (!env.DB) return;

        await schema(env.DB);
        await releaseFinished(env.DB);
      })()
    );
  }
};
