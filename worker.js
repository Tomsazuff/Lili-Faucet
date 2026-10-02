
const OWNER_USER_ID = "lili";
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
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function rateFor(days) {
  return MINING_RATES[Number(days)] || 0;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(hash)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

async function addColumn(db, table, column, type) {
  try {
    await db
      .prepare(ALTER TABLE ${table} ADD COLUMN ${column} ${type})
      .run();
  } catch (_) {}
}

async function user(db, id) {
  return db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first();
}

async function ensureUser(db, id) {
  id = clean(id);

  if (!id) {
    throw new Error("Chýba používateľské ID.");
  }

  let u = await user(db, id);

  if (u) {
    return u;
  }

  await db
    .prepare(
      INSERT INTO users
      (id, bank_sats, mining_sats, created_at, password_hash, is_registered)
      VALUES (?, 0, 0, ?, NULL, 0)
    )
    .bind(id, now())
    .run();

  return user(db, id);
}

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
        started_at TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        earned_sats INTEGER NOT NULL DEFAULT 0,
        released_at TEXT
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

  await addColumn(db, "users", "password_hash", "TEXT");
  await addColumn(db, "users", "is_registered", "INTEGER NOT NULL DEFAULT 0");

  await ensureUser(db, OWNER_USER_ID);

  await db
    .prepare(
      UPDATE users
      SET is_registered = 1
      WHERE id = ?
    )
    .bind(OWNER_USER_ID)
    .run();
}

async function register(db, id, password, referrer) {
  id = clean(id).toLowerCase();
  password = clean(password);
  referrer = clean(referrer).toLowerCase();

  if (!/^[a-z0-9_]{3,24}$/.test(id)) {
    throw new Error(
      "ID musí mať 3–24 znakov: a-z, 0-9 alebo _."
    );
  }

  if (password.length < 6) {
    throw new Error("Heslo musí mať aspoň 6 znakov.");
  }

  if (id === OWNER_USER_ID) {
    throw new Error("Toto ID je vyhradené.");
  }

const existing = await user(db, id);

  if (
    existing &&
    Number(existing.is_registered || 0) === 1
  ) {
    throw new Error("Účet už existuje.");
  }

  if (referrer === id) {
    referrer = "";
  }

  if (referrer) {
    const ref = await user(db, referrer);

    if (
      !ref ||
      Number(ref.is_registered || 0) !== 1
    ) {
      referrer = "";
    }
  }

  const hash = await sha256(password);

  if (existing) {
    await db
      .prepare(
        UPDATE users
        SET password_hash = ?,
            is_registered = 1
        WHERE id = ?
      )
      .bind(hash, id)
      .run();
  } else {
    await db
      .prepare(
        INSERT INTO users
        (id, bank_sats, mining_sats, created_at,
         password_hash, is_registered)
        VALUES (?, 0, 0, ?, ?, 1)
      )
      .bind(id, now(), hash)
      .run();
  }

  if (referrer) {
    await db
      .prepare(
        INSERT OR IGNORE INTO referrals
        (user_id, referrer_id, created_at)
        VALUES (?, ?, ?)
      )
      .bind(id, referrer, now())
      .run();
  }

  return {
    user_id: id,
    referrer_id: referrer || null
  };
}

async function login(db, id, password) {
  id = clean(id).toLowerCase();

  const u = await user(db, id);

  if (
    !u ||
    Number(u.is_registered || 0) !== 1
  ) {
    throw new Error(
      "Účet neexistuje alebo nie je zaregistrovaný."
    );
  }

  const hash = await sha256(password);

  if (hash !== u.password_hash) {
    throw new Error("Nesprávne heslo.");
  }

  return {
    user_id: id
  };
}

async function state(db, id) {
  id = clean(id);

  if (!id) {
    throw new Error("Chýba user_id.");
  }

  await ensureUser(db, id);

  const u = await user(db, id);

  const cycles = await db
    .prepare(
      SELECT *
      FROM mining_cycles
      WHERE user_id = ?
      ORDER BY id DESC
    )
    .bind(id)
    .all();

  const referral = await db
    .prepare(
      SELECT *
      FROM referrals
      WHERE user_id = ?
    )
    .bind(id)
    .first();

  return {
    user_id: id,
    bank_sats: Number(u.bank_sats || 0),
    mining_sats: Number(u.mining_sats || 0),
    referral: referral || null,
    mining_rates: MINING_RATES,
    cycles: cycles.results || []
  };
}

async function bankToMining(db, id, amount) {
  amount = Math.floor(Number(amount));

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Neplatná suma.");
  }

  const u = await user(db, id);

  if (!u) {
    throw new Error("Používateľ neexistuje.");
  }

  if (Number(u.bank_sats) < amount) {
    throw new Error("V Banku nie je dostatok satoshi.");
  }

  await db.batch([
    db
      .prepare(
        UPDATE users
        SET bank_sats = bank_sats - ?,
            mining_sats = mining_sats + ?
        WHERE id = ?
      )
      .bind(amount, amount, id),

    db
      .prepare(
        INSERT INTO transactions
        (user_id, type, amount_sats,
         bank_change_sats, mining_change_sats,
         reference, created_at)
        VALUES (?, 'BANK_TO_MINING', ?, ?, ?, ?, ?)
      )
      .bind(
        id,
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

async function startMining(db, id, days) {
  days = Number(days);

  if (!ALLOWED_DAYS.includes(days)) {
    throw new Error(
      "Povolené sú iba 1, 5, 10, 20 alebo 30 dní."
    );
  }

  const u = await user(db, id);

  if (!u) {
    throw new Error("Používateľ neexistuje.");
  }

  const amount = Number(u.mining_sats || 0);

  if (amount <= 0) {
    throw new Error(
      "Mining zostatok je 0."
    );
  }

  const started = new Date();

  const ends = new Date(
    started.getTime() +
    days * 86400000
  );

  const result = await db
    .prepare(`

INSERT INTO mining_cycles
      (user_id, principal_sats, started_at,
       duration_days, ends_at, status, earned_sats)
      VALUES (?, ?, ?, ?, ?, 'active', 0)
    )
    .bind(
      id,
      amount,
      started.toISOString(),
      days,
      ends.toISOString()
    )
    .run();

  const cycleId =
    result.meta.last_row_id;

  await db.batch([
    db
      .prepare(
        UPDATE users
        SET mining_sats = 0
        WHERE id = ?
      )
      .bind(id),

    db
      .prepare(
        INSERT INTO transactions
        (user_id, type, amount_sats,
         bank_change_sats, mining_change_sats,
         reference, created_at)
        VALUES (?, 'MINING_START', ?, 0, ?, ?, ?)
      )
      .bind(
        id,
        amount,
        -amount,
        "cycle:" + cycleId,
        now()
      )
  ]);

  return {
    cycle_id: cycleId,
    principal_sats: amount,
    ends_at: ends.toISOString(),
    rate: rateFor(days)
  };
}

async function withdraw(
  db,
  id,
  amount,
  method,
  address
) {
  amount = Math.floor(Number(amount));
  method = clean(method);
  address = clean(address);

  const u = await user(db, id);

  if (!u) {
    throw new Error("Používateľ neexistuje.");
  }

  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL_SATS
  ) {
    throw new Error(
      "Minimum výberu je 100 sat."
    );
  }

  if (!method || !address) {
    throw new Error(
      "Chýba spôsob alebo adresa výplaty."
    );
  }

  if (Number(u.bank_sats) < amount) {
    throw new Error(
      "V Banku nie je dostatok satoshi."
    );
  }

  const result = await db
    .prepare(
      INSERT INTO withdrawals
      (user_id, amount_sats, method,
       address, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    )
    .bind(
      id,
      amount,
      method,
      address,
      now()
    )
    .run();

  await db.batch([
    db
      .prepare(
        UPDATE users
        SET bank_sats = bank_sats - ?
        WHERE id = ?
      )
      .bind(amount, id),

    db
      .prepare(
        INSERT INTO transactions
        (user_id, type, amount_sats,
         bank_change_sats, mining_change_sats,
         reference, created_at)
        VALUES (?, 'WITHDRAWAL', ?, ?, 0, ?, ?)
      `)
      .bind(
        id,
        amount,
        -amount,
        "withdrawal:" + result.meta.last_row_id,
        now()
      )
  ]);

  return {
    withdrawal_id: result.meta.last_row_id,
    amount_sats: amount,
    status: "pending"
  };
}

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return json({}, 204);
    }

    if (!env.DB) {
      return json({
        ok: false,
        error: "D1 binding DB nie je pripojený."
      }, 500);
    }

    try {

      await createTables(env.DB);

      const url =
        new URL(request.url);

      const path =
        url.pathname.replace(/\/+$/, "") || "/";


      if (path === "/") {
        return json({
          ok: true,
          name: "Lili Faucet",
          status: "online",
          version: "BASE-1"
        });
      }


      if (
        path === "/api/register" &&
        request.method === "POST"
      ) {

        const body =
          await request.json();

        const result =
          await register(
            env.DB,
            body.user_id,
            body.password,
            body.referrer_id
          );

        return json({
          ok: true,
          ...result
        });
      }


      if (
        path === "/api/login" &&
        request.method === "POST"
      ) {

        const body =
          await request.json();

        const result =
          await login(
            env.DB,
            body.user_id,
            body.password
          );

        return json({
          ok: true,
          ...result
        });
      }


      if (
        path === "/api/state" &&
        request.method === "GET"
      ) {

return json({
          ok: true,
          ...(await state(
            env.DB,
            url.searchParams.get("user_id")
          ))
        });
      }


      if (
        path === "/api/bank/to-mining" &&
        request.method === "POST"
      ) {

        const body =
          await request.json();

        return json({
          ok: true,
          ...(await bankToMining(
            env.DB,
            clean(body.user_id),
            body.amount_sats
          ))
        });
      }


      if (
        path === "/api/mining/start" &&
        request.method === "POST"
      ) {

        const body =
          await request.json();

        return json({
          ok: true,
          ...(await startMining(
            env.DB,
            clean(body.user_id),
            body.duration_days
          ))
        });
      }


      if (
        path === "/api/withdraw" &&
        request.method === "POST"
      ) {

        const body =
          await request.json();

        return json({
          ok: true,
          ...(await withdraw(
            env.DB,
            clean(body.user_id),
            body.amount_sats,
            body.method,
            body.address
          ))
        });
      }


      if (
        path === "/api/transactions" &&
        request.method === "GET"
      ) {

        const id =
          clean(
            url.searchParams.get("user_id")
          );

        const rows =
          await env.DB
            .prepare(
              SELECT *
              FROM transactions
              WHERE user_id = ?
              ORDER BY id DESC
              LIMIT 100
            )
            .bind(id)
            .all();

        return json({
          ok: true,
          transactions:
            rows.results || []
        });
      }


      return json({
        ok: false,
        error: "Endpoint neexistuje."
      }, 404);


    } catch (error) {

      console.error(error);

      return json({
        ok: false,
        error:
          error?.message ||
          String(error)
      }, 500);
    }
  }
};
