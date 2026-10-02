Pata Hutira:
const OWNER = "lili";
const MIN_WITHDRAWAL = 100;

const WEB_SHARE = 0.95;
const USER_SHARE = 0.05;

const PROVIDERS = ["aoyco", "octoclick"];

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const ALLOWED_DAYS = [1, 5, 10, 20, 30];

const now = () => new Date().toISOString();
const clean = (v) => String(v ?? "").trim();

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Provider-Key"
    }
  });
}

async function readBody(request) {
  const type =
    request.headers.get("content-type") || "";

  if (type.includes("application/json")) {
    return await request.json();
  }

  return Object.fromEntries(
    (await request.formData()).entries()
  );
}

async function sha256(value) {
  const bytes =
    new TextEncoder().encode(
      String(value ?? "")
    );

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return Array.from(
    new Uint8Array(hash)
  )
    .map(
      (x) =>
        x.toString(16).padStart(2, "0")
    )
    .join("");
}

function token() {
  const bytes =
    new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map(
      (x) =>
        x.toString(16).padStart(2, "0")
    )
    .join("");
}

function userId(value) {
  const id =
    clean(value).toLowerCase();

  if (
    !/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(id)
  ) {
    throw new Error(
      "Používateľské ID musí mať 3–64 znakov."
    );
  }

  return id;
}

function email(value) {
  const e =
    clean(value).toLowerCase();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  ) {
    throw new Error(
      "Zadaj platný e-mail."
    );
  }

  return e;
}

async function addColumn(
  db,
  sql
) {
  try {
    await db.prepare(sql).run();
  } catch (_) {}
}


/* =====================================================
   DATABASE
===================================================== */

async function schema(db) {

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, bank_sats INTEGER NOT NULL DEFAULT 0, mining_sats INTEGER NOT NULL DEFAULT 0, created_at TEXT, password_hash TEXT, is_registered INTEGER NOT NULL DEFAULT 0, email TEXT)"
  ).run();

  await addColumn(
    db,
    "ALTER TABLE users ADD COLUMN bank_sats INTEGER NOT NULL DEFAULT 0"
  );

  await addColumn(
    db,
    "ALTER TABLE users ADD COLUMN mining_sats INTEGER NOT NULL DEFAULT 0"
  );

  await addColumn(
    db,
    "ALTER TABLE users ADD COLUMN created_at TEXT"
  );

  await addColumn(
    db,
    "ALTER TABLE users ADD COLUMN password_hash TEXT"
  );

  await addColumn(
    db,
    "ALTER TABLE users ADD COLUMN is_registered INTEGER NOT NULL DEFAULT 0"
  );

  await addColumn(
    db,
    "ALTER TABLE users ADD COLUMN email TEXT"
  );

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL, referrer_id TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS mining_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, principal_sats INTEGER NOT NULL, duration_days INTEGER NOT NULL, rate REAL NOT NULL, earned_sats INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, ends_at TEXT NOT NULL, released_at TEXT, status TEXT NOT NULL DEFAULT 'active')"
  ).run();

await db.prepare(
    "CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL, amount_sats INTEGER NOT NULL, bank_change_sats INTEGER NOT NULL DEFAULT 0, mining_change_sats INTEGER NOT NULL DEFAULT 0, reference TEXT, created_at TEXT NOT NULL)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS provider_earnings (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, user_id TEXT NOT NULL, provider_ref TEXT UNIQUE NOT NULL, publisher_sats INTEGER NOT NULL, web_sats INTEGER NOT NULL, user_sats INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, amount_sats INTEGER NOT NULL, method TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, processed_at TEXT)"
  ).run();

  await ensureUser(
    db,
    OWNER
  );
}


/* =====================================================
   USERS
===================================================== */

async function getUser(
  db,
  id
) {

  return await db
    .prepare(
      "SELECT * FROM users WHERE id=? LIMIT 1"
    )
    .bind(id)
    .first();
}


async function ensureUser(
  db,
  id
) {

  id =
    clean(id).toLowerCase();

  let user =
    await getUser(
      db,
      id
    );

  if (!user) {

    await db
      .prepare(
        "INSERT INTO users (id, bank_sats, mining_sats, created_at, is_registered) VALUES (?,0,0,?,0)"
      )
      .bind(
        id,
        now()
      )
      .run();

    user =
      await getUser(
        db,
        id
      );
  }

  return user;
}


/* =====================================================
   SESSION
===================================================== */

async function createSession(
  db,
  id
) {

  const raw =
    token();

  const hash =
    await sha256(raw);

  const expires =
    new Date(
      Date.now() +
      30 * 86400000
    ).toISOString();

  await db
    .prepare(
      "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)"
    )
    .bind(
      hash,
      id,
      expires,
      now()
    )
    .run();

  return raw;
}


async function requireAuth(
  request,
  db
) {

  const header =
    request.headers.get(
      "Authorization"
    ) || "";

  if (
    !header.startsWith(
      "Bearer "
    )
  ) {
    throw response(
      {
        ok: false,
        error:
          "Nie si prihlásený."
      },
      401
    );
  }

  const hash =
    await sha256(
      header
        .slice(7)
        .trim()
    );

  const session =
    await db
      .prepare(
        "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>? LIMIT 1"
      )
      .bind(
        hash,
        now()
      )
      .first();

  if (!session) {
    throw response(
      {
        ok: false,
        error:
          "Relácia skončila. Prihlás sa znova."
      },
      401
    );
  }

  return session.user_id;
}


/* =====================================================
   REGISTRATION
===================================================== */

async function register(
  db,
  body
) {

  const id =
    userId(
      body.user_id
    );

  const em =
    email(
      body.email
    );

  const pass =
    String(
      body.password ?? ""
    );

  if (
    pass.length < 6
  ) {
    throw new Error(
      "Heslo musí mať aspoň 6 znakov."
    );
  }

  if (
    id === OWNER
  ) {
    throw new Error(
      "Toto ID je vyhradené."
    );
  }

  const existing =
    await getUser(
      db,
      id
    );

  if (
    existing &&
    Number(
      existing.is_registered || 0
    ) === 1
  ) {
    throw new Error(
      "Tento používateľ už existuje."
    );
  }

  const sameEmail =
    await db
      .prepare(
        "SELECT id FROM users WHERE lower(email)=? AND is_registered=1 LIMIT 1"
      )
      .bind(em)
      .first();

if (
    sameEmail &&
    sameEmail.id !== id
  ) {
    throw new Error(
      "Tento e-mail už existuje."
    );
  }

  const passHash =
    await sha256(
      pass
    );

  if (existing) {

    await db
      .prepare(
        "UPDATE users SET password_hash=?, email=?, is_registered=1 WHERE id=?"
      )
      .bind(
        passHash,
        em,
        id
      )
      .run();

  } else {

    await db
      .prepare(
        "INSERT INTO users (id,bank_sats,mining_sats,created_at,password_hash,is_registered,email) VALUES (?,0,0,?,?,1,?)"
      )
      .bind(
        id,
        now(),
        passHash,
        em
      )
      .run();
  }

  const ref =
    clean(
      body.referrer_id
    ).toLowerCase();

  if (
    ref &&
    ref !== id
  ) {

    const refUser =
      await getUser(
        db,
        ref
      );

    if (
      refUser &&
      Number(
        refUser.is_registered || 0
      ) === 1
    ) {

      const already =
        await db
          .prepare(
            "SELECT id FROM referrals WHERE user_id=? LIMIT 1"
          )
          .bind(id)
          .first();

      if (!already) {

        await db
          .prepare(
            "INSERT INTO referrals (user_id,referrer_id,created_at) VALUES (?,?,?)"
          )
          .bind(
            id,
            ref,
            now()
          )
          .run();
      }
    }
  }

  return {
    user_id:
      id,

    token:
      await createSession(
        db,
        id
      )
  };
}


/* =====================================================
   LOGIN
===================================================== */

async function login(
  db,
  body
) {

  const login =
    clean(
      body.login
    ).toLowerCase();

  const pass =
    String(
      body.password ?? ""
    );

  const user =
    await db
      .prepare(
        "SELECT * FROM users WHERE lower(id)=? OR lower(email)=? LIMIT 1"
      )
      .bind(
        login,
        login
      )
      .first();

  if (
    !user ||
    Number(
      user.is_registered || 0
    ) !== 1
  ) {
    throw new Error(
      "Účet neexistuje."
    );
  }

  if (
    user.password_hash !==
    await sha256(pass)
  ) {
    throw new Error(
      "Nesprávne heslo."
    );
  }

  return {
    user_id:
      user.id,

    token:
      await createSession(
        db,
        user.id
      )
  };
}


/* =====================================================
   MINING ACCRUAL
===================================================== */

async function accrue(
  db,
  id
) {

  const rows =
    await db
      .prepare(
        "SELECT * FROM mining_cycles WHERE user_id=? AND status='active'"
      )
      .bind(id)
      .all();

  for (
    const c of
    rows.results || []
  ) {

    const start =
      Date.parse(
        c.started_at
      );

    const end =
      Date.parse(
        c.ends_at
      );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }

    const progress =
      Math.min(
        1,
        Math.max(
          0,
          (
            Math.min(
              Date.now(),
              end
            ) -
            start
          ) /
          (end - start)
        )
      );

    const target =
      Math.floor(
        Number(
          c.principal_sats
        ) *
        Number(
          c.rate
        )
      );

    const earned =
      Math.floor(
        target *
        progress
      );

    if (
      earned >
      Number(
        c.earned_sats || 0
      )
    ) {

      await db
        .prepare(
          "UPDATE mining_cycles SET earned_sats=? WHERE id=? AND status='active'"
        )
        .bind(
          earned,
          c.id
        )
        .run();
    }
  }
}


/* =====================================================
   RELEASE FINISHED MINING
===================================================== */

async function releaseFinished(
  db
) {

const rows =
    await db
      .prepare(
        "SELECT * FROM mining_cycles WHERE status='active' AND ends_at<=?"
      )
      .bind(
        now()
      )
      .all();

  for (
    const c0 of
    rows.results || []
  ) {

    await accrue(
      db,
      c0.user_id
    );

    const c =
      await db
        .prepare(
          "SELECT * FROM mining_cycles WHERE id=? AND status='active'"
        )
        .bind(
          c0.id
        )
        .first();

    if (!c) {
      continue;
    }

    const principal =
      Number(
        c.principal_sats || 0
      );

    const earned =
      Number(
        c.earned_sats || 0
      );

    const total =
      principal +
      earned;

    await db.batch([

      db
        .prepare(
          "UPDATE users SET bank_sats=bank_sats+? WHERE id=?"
        )
        .bind(
          total,
          c.user_id
        ),

      db
        .prepare(
          "UPDATE mining_cycles SET status='released', released_at=? WHERE id=? AND status='active'"
        )
        .bind(
          now(),
          c.id
        ),

      db
        .prepare(
          "INSERT INTO transactions (user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) VALUES (?,?,?,?,?,?,?)"
        )
        .bind(
          c.user_id,
          "MINING_RELEASE",
          total,
          total,
          0,
          "cycle:" + c.id,
          now()
        )
    ]);
  }
}


/* =====================================================
   STATE
===================================================== */

async function state(
  db,
  id
) {

  await releaseFinished(
    db
  );

  await accrue(
    db,
    id
  );

  const user =
    await getUser(
      db,
      id
    );

  const cycles =
    await db
      .prepare(
        "SELECT * FROM mining_cycles WHERE user_id=? ORDER BY id DESC"
      )
      .bind(id)
      .all();

  return {

    ok: true,

    user_id:
      id,

    bank_sats:
      Number(
        user?.bank_sats || 0
      ),

    mining_sats:
      Number(
        user?.mining_sats || 0
      ),

    cycles:
      cycles.results || []
  };
}


/* =====================================================
   BANK → MINING
===================================================== */

async function bankToMining(
  db,
  id,
  amount
) {

  amount =
    Math.floor(
      Number(amount)
    );

  if (
    !Number.isFinite(amount) ||
    amount < 1
  ) {
    throw new Error(
      "Zadaj platnú sumu."
    );
  }

  const user =
    await getUser(
      db,
      id
    );

  if (
    Number(
      user?.bank_sats || 0
    ) < amount
  ) {
    throw new Error(
      "V Banku nemáš dostatok sat."
    );
  }

  await db.batch([

    db
      .prepare(
        "UPDATE users SET bank_sats=bank_sats-?, mining_sats=mining_sats+? WHERE id=? AND bank_sats>=?"
      )
      .bind(
        amount,
        amount,
        id,
        amount
      ),

    db
      .prepare(
        "INSERT INTO transactions (user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        id,
        "BANK_TO_MINING",
        amount,
        -amount,
        amount,
        "bank_to_mining",
        now()
      )
  ]);

  return {
    ok: true,
    amount_sats:
      amount
  };
}


/* =====================================================
   START MINING
===================================================== */

async function startMining(
  db,
  id,
  days
) {

  days =
    Number(days);

  if (
    !ALLOWED_DAYS.includes(
      days
    )
  ) {
    throw new Error(
      "Povolené obdobia: 1, 5, 10, 20 alebo 30 dní."
    );
  }

  await releaseFinished(
    db
  );

  const user =
    await getUser(
      db,
      id
    );

  const amount =
    Number(
      user?.mining_sats || 0
    );

  if (
    amount < 1
  ) {
    throw new Error(
      "V Mining nemáš žiadne sat."
    );
  }

  const started =
    new Date();

  const ends =
    new Date(
      started.getTime() +
      days *
      86400000
    );

const result =
    await db
      .prepare(
        "INSERT INTO mining_cycles (user_id,principal_sats,duration_days,rate,earned_sats,started_at,ends_at,status) VALUES (?,?,?,?,0,?,?,?)"
      )
      .bind(
        id,
        amount,
        days,
        MINING_RATES[days],
        started.toISOString(),
        ends.toISOString(),
        "active"
      )
      .run();

  const cycleId =
    result.meta?.last_row_id ??
    null;

  await db.batch([

    db
      .prepare(
        "UPDATE users SET mining_sats=0 WHERE id=? AND mining_sats>=?"
      )
      .bind(
        id,
        amount
      ),

    db
      .prepare(
        "INSERT INTO transactions (user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        id,
        "MINING_START",
        amount,
        0,
        -amount,
        "cycle:" + cycleId,
        now()
      )
  ]);

  return {

    ok: true,

    cycle_id:
      cycleId,

    principal_sats:
      amount,

    duration_days:
      days,

    rate:
      MINING_RATES[days],

    ends_at:
      ends.toISOString()
  };
}


/* =====================================================
   REFERRALS
===================================================== */

async function referrals(
  db,
  id
) {

  const row =
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM referrals WHERE referrer_id=?"
      )
      .bind(id)
      .first();

  return {
    ok: true,
    count:
      Number(
        row?.count || 0
      )
  };
}


/* =====================================================
   PROVIDER POSTBACK
===================================================== */

async function providerPostback(
  db,
  provider,
  body
) {

  provider =
    clean(
      provider
    ).toLowerCase();

  if (
    !PROVIDERS.includes(
      provider
    )
  ) {
    throw new Error(
      "Neznámy provider."
    );
  }

  const id =
    clean(
      body.user_id
    ).toLowerCase();

  const ref =
    clean(
      body.provider_ref ||
      body.transaction_id ||
      body.txid ||
      body.id
    );

  const gross =
    Math.floor(
      Number(
        body.publisher_sats ??
        body.amount_sats ??
        body.amount
      )
    );

  if (
    !id ||
    !ref ||
    !Number.isFinite(gross) ||
    gross <= 0
  ) {
    throw new Error(
      "Neplatný provider postback."
    );
  }

  const duplicate =
    await db
      .prepare(
        "SELECT id FROM provider_earnings WHERE provider_ref=? LIMIT 1"
      )
      .bind(ref)
      .first();

  if (duplicate) {
    return {
      ok: true,
      duplicate: true
    };
  }

  const user =
    await getUser(
      db,
      id
    );

  if (
    !user ||
    Number(
      user.is_registered || 0
    ) !== 1
  ) {
    throw new Error(
      "Používateľ neexistuje."
    );
  }

  const web =
    Math.floor(
      gross *
      WEB_SHARE
    );

  const userShare =
    gross -
    web;

  await db.batch([

    db
      .prepare(
        "INSERT INTO provider_earnings (provider,user_id,provider_ref,publisher_sats,web_sats,user_sats,status,created_at) VALUES (?,?,?,?,?,?,?,?)"
      )
      .bind(
        provider,
        id,
        ref,
        gross,
        web,
        userShare,
        "confirmed",
        now()
      ),

    db
      .prepare(
        "UPDATE users SET bank_sats=bank_sats+? WHERE id=?"
      )
      .bind(
        web,
        OWNER
      ),

    db
      .prepare(
        "UPDATE users SET bank_sats=bank_sats+? WHERE id=?"
      )
      .bind(
        userShare,
        id
      ),

    db
      .prepare(
        "INSERT INTO transactions (user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        OWNER,
        "PROVIDER_WEB",
        web,
        web,
        0,
        provider + ":" + ref,
        now()
      ),

db
      .prepare(
        "INSERT INTO transactions (user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        id,
        "PROVIDER_REWARD",
        userShare,
        userShare,
        0,
        provider + ":" + ref,
        now()
      )
  ]);

  return {

    ok: true,

    duplicate:
      false,

    provider:
      provider,

    publisher_sats:
      gross,

    web_sats:
      web,

    user_sats:
      userShare
  };
}


/* =====================================================
   WITHDRAW
===================================================== */

async function withdraw(
  db,
  id,
  body
) {

  const amount =
    Math.floor(
      Number(
        body.amount_sats
      )
    );

  const address =
    clean(
      body.address
    );

  const method =
    clean(
      body.method
    ) || "BTC";

  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL
  ) {
    throw new Error(
      "Minimum výberu je 100 sat."
    );
  }

  if (!address) {
    throw new Error(
      "Zadaj cieľ výplaty."
    );
  }

  const user =
    await getUser(
      db,
      id
    );

  if (
    Number(
      user?.bank_sats || 0
    ) < amount
  ) {
    throw new Error(
      "V Banku nemáš dostatok sat."
    );
  }

  const result =
    await db
      .prepare(
        "INSERT INTO withdrawals (user_id,amount_sats,method,address,status,created_at) VALUES (?,?,?,?,?,?)"
      )
      .bind(
        id,
        amount,
        method,
        address,
        "pending",
        now()
      )
      .run();

  const wid =
    result.meta?.last_row_id ??
    null;

  await db.batch([

    db
      .prepare(
        "UPDATE users SET bank_sats=bank_sats-? WHERE id=? AND bank_sats>=?"
      )
      .bind(
        amount,
        id,
        amount
      ),

    db
      .prepare(
        "INSERT INTO transactions (user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        id,
        "WITHDRAWAL_PENDING",
        amount,
        -amount,
        0,
        "withdrawal:" + wid,
        now()
      )
  ]);

  return {

    ok: true,

    withdrawal_id:
      wid,

    amount_sats:
      amount,

    status:
      "pending"
  };
}


/* =====================================================
   HISTORY
===================================================== */

async function history(
  db,
  id
) {

  const rows =
    await db
      .prepare(
        "SELECT id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100"
      )
      .bind(id)
      .all();

  return {

    ok: true,

    transactions:
      rows.results || []
  };
}


/* =====================================================
   ROUTER
===================================================== */

async function handle(
  request,
  env
) {

  if (!env.DB) {
    return response(
      {
        ok: false,
        error:
          "D1 binding DB nie je nastavený."
      },
      500
    );
  }

  const db =
    env.DB;

  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

  const method =
    request.method.toUpperCase();

  if (
    method === "OPTIONS"
  ) {
    return response({
      ok: true
    });
  }

  await schema(
    db
  );


  /* ROOT */

  if (
    method === "GET" &&
    path === "/"
  ) {

    return response({

      ok: true,

      service:
        "Lili Faucet worker",

      status:
        "online",

      version:
        "5.1.0",

      minimum_withdrawal_sats:
        MIN_WITHDRAWAL,

      publisher_split: {
        web:
          WEB_SHARE,

        invited_user:
          USER_SHARE
      },

      providers:
        PROVIDERS,

      mining_rates:
        MINING_RATES

    });
  }


  /* REGISTER */

  if (
    method === "POST" &&
    path === "/api/register"
  ) {

    try {

      return response({

        ok: true,

...await register(
          db,
          await readBody(
            request
          )
        )

      });

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message ||
            "Registrácia zlyhala."
        },
        400
      );
    }
  }


  /* LOGIN */

  if (
    method === "POST" &&
    path === "/api/login"
  ) {

    try {

      return response({

        ok: true,

        ...await login(
          db,
          await readBody(
            request
          )
        )

      });

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message ||
            "Prihlásenie zlyhalo."
        },
        401
      );
    }
  }


  /* PROVIDER */

  if (
    method === "POST" &&
    path.startsWith(
      "/api/provider/"
    )
  ) {

    const secret =
      clean(
        env.PROVIDER_SECRET
      );

    const supplied =
      clean(
        request.headers.get(
          "X-Provider-Key"
        )
      );

    if (
      !secret ||
      supplied !== secret
    ) {

      return response(
        {
          ok: false,
          error:
            "Neplatný provider key."
        },
        401
      );
    }

    try {

      return response(
        await providerPostback(
          db,
          path.slice(
            "/api/provider/".length
          ),
          await readBody(
            request
          )
        )
      );

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message ||
            "Provider postback zlyhal."
        },
        400
      );
    }
  }


  /* AUTH */

  let id;

  try {

    id =
      await requireAuth(
        request,
        db
      );

  } catch (e) {

    return e;
  }


  /* STATE */

  if (
    method === "GET" &&
    path === "/api/state"
  ) {

    try {

      return response(
        await state(
          db,
          id
        )
      );

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message
        },
        400
      );
    }
  }


  /* REFERRALS */

  if (
    method === "GET" &&
    path === "/api/referrals"
  ) {

    try {

      return response(
        await referrals(
          db,
          id
        )
      );

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message
        },
        400
      );
    }
  }


  /* HISTORY */

  if (
    method === "GET" &&
    path === "/api/transactions"
  ) {

    try {

      return response(
        await history(
          db,
          id
        )
      );

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message
        },
        400
      );
    }
  }


  /* BANK → MINING */

  if (
    method === "POST" &&
    path === "/api/bank/to-mining"
  ) {

    try {

      const body =
        await readBody(
          request
        );

      return response(
        await bankToMining(
          db,
          id,
          body.amount_sats
        )
      );

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message
        },
        400
      );
    }
  }


  /* START MINING */

  if (
    method === "POST" &&
    path === "/api/mining/start"
  ) {

    try {

      const body =
        await readBody(
          request
        );

      return response(
        await startMining(
          db,
          id,
          body.duration_days
        )
      );

    } catch (e) {

      return response(
        {
          ok: false,
          error:
            e.message
        },
        400
      );
    }
  }


  /* WITHDRAW */

  if (
    method === "POST" &&
    path === "/api/withdraw"
  ) {

    try {

      return response(
        await withdraw(
          db,
          id,
          await readBody(
            request
          )
        )
      );

    } catch (e) {

return response(
        {
          ok: false,
          error:
            e.message
        },
        400
      );
    }
  }


  return response(
    {
      ok: false,
      error:
        "Endpoint neexistuje."
    },
    404
  );
}


/* =====================================================
   CLOUDFLARE WORKER
===================================================== */

export default {

  async fetch(
    request,
    env
  ) {

    try {

      return await handle(
        request,
        env
      );

    } catch (e) {

      console.error(e);

      return response(
        {
          ok: false,
          error:
            e.message ||
            "Interná chyba Worker."
        },
        500
      );
    }
  },

  async scheduled(
    controller,
    env
  ) {

    if (!env.DB) {
      return;
    }

    await schema(
      env.DB
    );

    await releaseFinished(
      env.DB
    );
  }
};
