
const OWNER = "lili";
const MIN_WITHDRAW = 100;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers":
        "Content-Type, Authorization, X-Provider-Secret"
    }
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function now() {
  return Date.now();
}

function token() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function rateFor(days) {
  return MINING_RATES[Number(days)] || 0;
}


/* =========================
   DATABASE
========================= */

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


/* =========================
   USER / LOGIN
========================= */

async function getUser(db, id) {
  return db
    .prepare(SELECT * FROM users WHERE id=?)
    .bind(id)
    .first();
}

async function createSession(db, userId) {

  const sessionToken = token();
  const expires = now() + 30 * 24 * 60 * 60 * 1000;

await db.prepare(
    INSERT INTO sessions
    (token,user_id,created_at,expires_at)
    VALUES (?,?,?,?)
  )
    .bind(
      sessionToken,
      userId,
      now(),
      expires
    )
    .run();

  return sessionToken;
}

async function auth(request, db) {

  const header =
    request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const sessionToken =
    header.slice(7).trim();

  if (!sessionToken) {
    return null;
  }

  return db.prepare(
    SELECT
      u.*,
      s.token,
      s.expires_at
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=?
      AND s.expires_at>?
  )
    .bind(
      sessionToken,
      now()
    )
    .first();
}


/* =========================
   MINING RELEASE
========================= */

async function releaseFinished(db) {

  const rows = await db.prepare(
    SELECT *
    FROM mining_cycles
    WHERE released=0
      AND end_at<=?
  )
    .bind(now())
    .all();

  for (const cycle of rows.results || []) {

    const principal =
      Number(cycle.principal_sats);

    const profit =
      Math.floor(
        principal * Number(cycle.rate)
      );

    const total =
      principal + profit;

    const update =
      await db.prepare(
        UPDATE users
        SET bank_sats=bank_sats+?
        WHERE id=?
      )
        .bind(
          total,
          cycle.user_id
        )
        .run();

    if (
      Number(update.meta?.changes || 0) !== 1
    ) {
      continue;
    }

    const done =
      await db.prepare(
        UPDATE mining_cycles
        SET released=1
        WHERE id=?
          AND released=0
      )
        .bind(cycle.id)
        .run();

    if (
      Number(done.meta?.changes || 0) !== 1
    ) {
      continue;
    }

    await db.prepare(
      INSERT INTO transactions
      (user_id,type,amount_sats,description,created_at)
      VALUES (?,?,?,?,?)
    )
      .bind(
        cycle.user_id,
        "mining_release",
        total,
        Mining ${cycle.duration_days} dní: vklad ${principal} sat + zisk ${profit} sat,
        now()
      )
      .run();
  }
}


/* =========================
   REGISTER
========================= */

async function register(db, data) {

  const id =
    String(data.user_id || "")
      .trim()
      .toLowerCase();

  const email =
    String(data.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(data.password || "");

  const referrer =
    String(data.referrer_id || "")
      .trim()
      .toLowerCase();

  if (!id || id.length < 3) {
    return json({
      error:
        "Používateľské meno musí mať aspoň 3 znaky."
    }, 400);
  }

  if (!email || !email.includes("@")) {
    return json({
      error: "Zadaj platný email."
    }, 400);
  }

  if (password.length < 6) {
    return json({
      error:
        "Heslo musí mať aspoň 6 znakov."
    }, 400);
  }

  if (id === OWNER) {
    return json({
      error:
        "Toto používateľské meno je rezervované."
    }, 400);
  }

  const existing =
    await getUser(db, id);

  if (
    existing &&
    Number(existing.is_registered) === 1
  ) {
    return json({
      error:
        "Používateľ už existuje."
    }, 409);
  }

  const passwordHash =
    await hashPassword(password);

  if (existing) {

    await db.prepare(
      UPDATE users
      SET email=?,
          password_hash=?,
          is_registered=1
      WHERE id=?
    )
      .bind(
        email,
        passwordHash,
        id
      )
      .run();

  } else {

    await db.prepare(
      INSERT INTO users
      (id,email,password_hash,bank_sats,
       mining_sats,is_registered,created_at)
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


  /* REFERRAL */

  if (
    referrer &&
    referrer !== id
  ) {

    const refUser =
      await getUser(db, referrer);

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
        .bind(
          referrer,
          id,
          now()
        )
        .run();
    }
  }

  const session =
    await createSession(
      db,
      id
    );

  return json({
    ok: true,
    user_id: id,
    token: session
  });
}


/* =========================
   LOGIN
========================= */

async function login(db, data) {

  const loginValue =
    String(data.login || "")
      .trim()
      .toLowerCase();

  const password =
    String(data.password || "");

  if (!loginValue || !password) {
    return json({
      error:
        "Vyplň prihlasovacie údaje."
    }, 400);
  }

  const user =
    await db.prepare(
      SELECT *
      FROM users
      WHERE id=? OR email=?
      LIMIT 1
    )
      .bind(
        loginValue,
        loginValue
      )
      .first();

  if (
    !user ||
    Number(user.is_registered) !== 1
  ) {
    return json({
      error:
        "Nesprávne prihlasovacie údaje."
    }, 401);
  }

  const passwordHash =
    await hashPassword(password);

  if (
    passwordHash !==
    user.password_hash
  ) {
    return json({
      error:
        "Nesprávne prihlasovacie údaje."
    }, 401);
  }

  const session =
    await createSession(
      db,
      user.id
    );

  return json({
    ok: true,
    user_id: user.id,
    token: session
  });
}


/* =========================
   STATE
========================= */

async function state(db, user) {

  const cycles =
    await db.prepare(
      SELECT *
      FROM mining_cycles
      WHERE user_id=?
        AND released=0
      ORDER BY id DESC
    )
      .bind(user.id)
      .all();

  const active =
    (cycles.results || [])
      .map(cycle => {

        const start =
          Number(cycle.start_at);

        const end =
          Number(cycle.end_at);

        const progress =
          Math.min(
            1,
            Math.max(
              0,
              (now() - start) /
              Math.max(
                1,
                end - start
              )
            )
          );

        const principal =
          Number(cycle.principal_sats);

        const profit =
          Math.floor(
            principal *
            Number(cycle.rate)
          );

        return {
          id: cycle.id,
          principal_sats: principal,
          duration_days:
            Number(cycle.duration_days),
          rate:
            Number(cycle.rate),
          profit_sats: profit,
          final_sats:
            principal + profit,
          progress,
          end_at: end
        };
      });

  return json({
    ok: true,

    user: {
      id: user.id,
      email: user.email,
      bank_sats:
        Number(user.bank_sats || 0),
      mining_sats:
        Number(user.mining_sats || 0)
    },

    mining: active,

    mining_rates:
      MINING_RATES,

    min_withdraw:
      MIN_WITHDRAW
  });
}


/* =========================
   BANK → MINING
========================= */

async function bankToMining(db, user, data) {

  const amount =
    Math.floor(
      Number(data.amount_sats)
    );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return json({
      error: "Neplatná suma."
    }, 400);
  }

  const current =
    await getUser(
      db,
      user.id
    );

  if (
    Number(current.bank_sats) <
    amount
  ) {
    return json({
      error:
        "Na Banku nemáš dostatok satoshi."
    }, 400);
  }

  const result =
    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats-?,
          mining_sats=mining_sats+?
      WHERE id=?
        AND bank_sats>=?
    )
      .bind(
        amount,
        amount,
        user.id,
        amount
      )
      .run();

if (
    Number(result.meta?.changes || 0) !== 1
  ) {
    return json({
      error:
        "Prenos sa nepodaril."
    }, 409);
  }

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES (?,?,?,?,?)
  )
    .bind(
      user.id,
      "bank_to_mining",
      amount,
      "Presun z Banku do Mining",
      now()
    )
    .run();

  return json({
    ok: true,
    amount_sats: amount
  });
}


/* =========================
   START MINING
========================= */

async function startMining(db, user, data) {

  const days =
    Number(data.duration_days);

  const rate =
    rateFor(days);

  if (!rate) {
    return json({
      error:
        "Povolené trvanie je 1, 5, 10, 20 alebo 30 dní."
    }, 400);
  }

  const current =
    await getUser(
      db,
      user.id
    );

  const amount =
    Number(
      current.mining_sats || 0
    );

  if (amount <= 0) {
    return json({
      error:
        "V Mining nemáš žiadne satoshi."
    }, 400);
  }

  const start =
    now();

  const end =
    start +
    days *
    24 *
    60 *
    60 *
    1000;

  const profit =
    Math.floor(
      amount * rate
    );

  const total =
    amount + profit;


  const result =
    await db.prepare(
      UPDATE users
      SET mining_sats=0
      WHERE id=?
        AND mining_sats=?
    )
      .bind(
        user.id,
        amount
      )
      .run();

  if (
    Number(result.meta?.changes || 0) !== 1
  ) {
    return json({
      error:
        "Spustenie miningu sa nepodarilo."
    }, 409);
  }


  await db.prepare(
    INSERT INTO mining_cycles
    (user_id,principal_sats,duration_days,
     rate,start_at,end_at,released,created_at)
    VALUES (?,?,?,?,?,?,0,?)
  )
    .bind(
      user.id,
      amount,
      days,
      rate,
      start,
      end,
      now()
    )
    .run();


  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES (?,?,?,?,?)
  )
    .bind(
      user.id,
      "mining_start",
      amount,
      Spustený mining na ${days} dní. Vklad ${amount} sat, očakávaný zisk ${profit} sat, spolu ${total} sat.,
      now()
    )
    .run();

  return json({
    ok: true,
    principal_sats: amount,
    profit_sats: profit,
    final_sats: total,
    duration_days: days,
    rate
  });
}


/* =========================
   REFERRALS
========================= */

async function referrals(db, user) {

  const rows =
    await db.prepare(
      SELECT
        referred_id,
        created_at
      FROM referrals
      WHERE referrer_id=?
      ORDER BY id DESC
    )
      .bind(user.id)
      .all();

  return json({
    ok: true,
    referral_id: user.id,
    count:
      (rows.results || []).length,
    referrals:
      rows.results || []
  });
}


/* =========================
   TRANSACTIONS
========================= */

async function transactions(db, user) {

  const rows =
    await db.prepare(
      SELECT
        id,
        type,
        amount_sats,
        description,
        created_at
      FROM transactions
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 200
    )
      .bind(user.id)
      .all();

  return json({
    ok: true,
    transactions:
      rows.results || []
  });
}


/* =========================
   WITHDRAW
========================= */

async function withdraw(db, user, data) {

  const amount =
    Math.floor(
      Number(data.amount_sats)
    );

  const method =
    String(
      data.method || "FaucetPay"
    ).trim();

  const address =
    String(
      data.address || ""
    ).trim();

  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAW
  ) {
    return json({
      error:
        Minimum výber je ${MIN_WITHDRAW} sat.
    }, 400);
  }

  if (!address) {
    return json({
      error:
        "Zadaj adresu alebo účet pre výplatu."
    }, 400);
  }

  const current =
    await getUser(
      db,
      user.id
    );

if (
    Number(current.bank_sats) <
    amount
  ) {
    return json({
      error:
        "Na Banku nemáš dostatok satoshi."
    }, 400);
  }

  const result =
    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats-?
      WHERE id=?
        AND bank_sats>=?
    )
      .bind(
        amount,
        user.id,
        amount
      )
      .run();

  if (
    Number(result.meta?.changes || 0) !== 1
  ) {
    return json({
      error:
        "Výber sa nepodaril."
    }, 409);
  }

  await db.prepare(
    INSERT INTO withdrawals
    (user_id,amount_sats,method,address,status,created_at)
    VALUES (?,?,?,?,?,?)
  )
    .bind(
      user.id,
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
      user.id,
      "withdrawal",
      amount,
      Výber ${method} – čaká na spracovanie,
      now()
    )
    .run();

  return json({
    ok: true,
    status: "pending",
    message:
      "Výber bol prijatý a čaká na spracovanie."
  });
}


/* =========================
   PROVIDER POSTBACK
========================= */

async function providerPostback(
  db,
  env,
  providerKey,
  data
) {

  const secret =
    env.PROVIDER_SECRET;

  if (!secret) {
    return json({
      error:
        "PROVIDER_SECRET nie je nastavený."
    }, 500);
  }

  const supplied =
    String(
      data.secret || ""
    );

  if (supplied !== secret) {
    return json({
      error:
        "Neplatný provider secret."
    }, 401);
  }

  const gross =
    Math.floor(
      Number(data.amount_sats)
    );

  const userId =
    String(
      data.user_id || ""
    )
      .trim()
      .toLowerCase();

  if (
    !userId ||
    !Number.isFinite(gross) ||
    gross <= 0
  ) {
    return json({
      error:
        "Neplatné údaje postbacku."
    }, 400);
  }

  const provider =
    PROVIDERS[providerKey];

  if (!provider) {
    return json({
      error:
        "Neznámy provider."
    }, 404);
  }

  const user =
    await getUser(
      db,
      userId
    );

  if (
    !user ||
    Number(user.is_registered) !== 1
  ) {
    return json({
      error:
        "Používateľ neexistuje."
    }, 404);
  }

  const bank =
    Math.floor(
      gross *
      provider.shareBank
    );

  const referral =
    gross - bank;


  const result =
    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    )
      .bind(
        bank,
        userId
      )
      .run();

  if (
    Number(result.meta?.changes || 0) !== 1
  ) {
    return json({
      error:
        "Pripísanie odmeny zlyhalo."
    }, 409);
  }


  const ref =
    await db.prepare(
      SELECT referrer_id
      FROM referrals
      WHERE referred_id=?
    )
      .bind(userId)
      .first();

  let referralPaid = 0;

  if (ref?.referrer_id) {

    const refResult =
      await db.prepare(
        UPDATE users
        SET bank_sats=bank_sats+?
        WHERE id=?
      )
        .bind(
          referral,
          ref.referrer_id
        )
        .run();

    if (
      Number(
        refResult.meta?.changes || 0
      ) === 1
    ) {
      referralPaid =
        referral;
    }
  }


  await db.prepare(
    INSERT INTO provider_earnings
    (provider,user_id,gross_sats,
     bank_sats,referral_sats,created_at)
    VALUES (?,?,?,?,?,?)
  )
    .bind(
      providerKey,
      userId,
      gross,
      bank,
      referralPaid,
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
      bank,
      ${provider.name} odmena – 95 % do Banku,
      now()
    )
    .run();


  if (referralPaid > 0) {

await db.prepare(
      INSERT INTO transactions
      (user_id,type,amount_sats,description,created_at)
      VALUES (?,?,?,?,?)
    )
      .bind(
        ref.referrer_id,
        "referral",
        referralPaid,
        Referral od ${provider.name} – 5 %,
        now()
      )
      .run();
  }


  return json({
    ok: true,
    provider: provider.name,
    gross_sats: gross,
    bank_sats: bank,
    referral_sats: referralPaid
  });
}


/* =========================
   MAIN WORKER
========================= */

export default {

  async fetch(request, env) {

    if (
      request.method === "OPTIONS"
    ) {
      return json({
        ok: true
      });
    }

    try {

      const db = env.DB;

      if (!db) {
        return json({
          error:
            "D1 binding DB nie je nastavený."
        }, 500);
      }


      await schema(db);

      await releaseFinished(db);


      const url =
        new URL(request.url);

      const path =
        url.pathname;

      const data =
        await readJson(request);


      /* ROOT */

      if (
        request.method === "GET" &&
        path === "/"
      ) {
        return json({
          ok: true,
          name: "Lili Faucet",
          status: "online"
        });
      }


      /* REGISTER */

      if (
        request.method === "POST" &&
        path === "/api/register"
      ) {
        return register(
          db,
          data
        );
      }


      /* LOGIN */

      if (
        request.method === "POST" &&
        path === "/api/login"
      ) {
        return login(
          db,
          data
        );
      }


      /* PROVIDERS */

      if (
        request.method === "POST" &&
        (
          path === "/api/provider/aoyco" ||
          path === "/api/provider/octoclick"
        )
      ) {

        const providerKey =
          path.endsWith("aoyco")
            ? "aoyco"
            : "octoclick";

        return providerPostback(
          db,
          env,
          providerKey,
          data
        );
      }


      /* AUTH */

      const user =
        await auth(
          request,
          db
        );

      if (!user) {
        return json({
          error:
            "Nie si prihlásený."
        }, 401);
      }


      /* STATE */

      if (
        request.method === "GET" &&
        path === "/api/state"
      ) {
        return state(
          db,
          user
        );
      }


      /* BANK → MINING */

      if (
        request.method === "POST" &&
        path === "/api/bank/to-mining"
      ) {
        return bankToMining(
          db,
          user,
          data
        );
      }


      /* START MINING */

      if (
        request.method === "POST" &&
        path === "/api/mining/start"
      ) {
        return startMining(
          db,
          user,
          data
        );
      }


      /* REFERRALS */

      if (
        request.method === "GET" &&
        path === "/api/referrals"
      ) {
        return referrals(
          db,
          user
        );
      }


      /* HISTORY */

      if (
        request.method === "GET" &&
        path === "/api/transactions"
      ) {
        return transactions(
          db,
          user
        );
      }


      /* WITHDRAW */

      if (
        request.method === "POST" &&
        path === "/api/withdraw"
      ) {
        return withdraw(
          db,
          user,
          data
        );
      }


      return json({
        error:
          "Endpoint neexistuje."
      }, 404);

    } catch (error) {

      return json({
        error:
          "Serverová chyba.",
        detail:
          String(
            error?.message ||
            error
          )
      }, 500);
    }
  }
};
