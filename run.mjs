#!/usr/bin/env node
import "dotenv/config";
import fs from "fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import fetch from "node-fetch";


const SOL_PK_ENV = process.env.SOL_PRIVATE_KEY;
const REFERRAL = process.env.TASHI_REFERRAL || "";

if (!SOL_PK_ENV) {
  console.error("❌ SOL_PRIVATE_KEY belum di-set di .env");
  process.exit(1);
}

const BASE_ORCH = "https://orchestrator.devnet.depin.infra.tashi.dev";
const BASE_WEB = "https://depin.tashi.network";
const DASHBOARD_JS_URL = "https://depin.tashi.network/_next/static/chunks/app/dashboard/page-d1eec4fd3763f282.js";


function loadPrivateKeys() {
  const val = SOL_PK_ENV.trim();
  if (fs.existsSync(val)) {
    const raw = fs.readFileSync(val, "utf8");
    return raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  }
  return [val];
}

/* ===========================
   Fetch mission IDs directly from JS — NO FALLBACK
   =========================== */

async function fetchMissionIdsFromDashboardJS() {
  console.log("[detect] Fetching mission IDs from dashboard JS...");
  const res = await fetch(DASHBOARD_JS_URL);
  if (!res.ok) {
    console.error(`[detect] Gagal fetch JS: ${res.status}`);
    process.exit(1);
  }

  const text = await res.text();
  const matches = text.match(/missionId:\s*(\d+)/g) || [];
  const ids = [...new Set(matches.map(m => parseInt(m.replace("missionId:", "").trim(), 10)))].sort((a, b) => a - b);

  if (ids.length === 0) {
    console.log("[detect] Tidak ada missionId ditemukan di JS → tidak ada mission untuk diklaim.");
    return []; // ✅ Tidak ada fallback
  }

  console.log(`[detect] Mission yang terdeteksi: ${ids.join(", ")}`);
  return ids;
}


async function http(url, opt = {}) {
  const res = await fetch(url, opt);
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  console.log(`\n[HTTP] ${opt.method || "GET"} ${url}`);
  console.log(`[HTTP] Status = ${res.status}`);
  return { ok: res.ok, status: res.status, data };
}

function makeKeypairFromPk(pkB58) {
  const secretKey = bs58.decode(pkB58);
  if (secretKey.length === 64) return nacl.sign.keyPair.fromSecretKey(secretKey);
  if (secretKey.length === 32) return nacl.sign.keyPair.fromSeed(secretKey);
  throw new Error("Private key harus 32 atau 64 bytes");
}

function signMessage(message, pkB58) {
  const sk = bs58.decode(pkB58);
  const sig = nacl.sign.detached(Buffer.from(message), sk);
  return bs58.encode(sig);
}


async function getNonce() {
  const body = REFERRAL ? { referredBy: REFERRAL } : {};
  const { data } = await http(`${BASE_ORCH}/v1/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { nonce: data.nonce, issuedAt: data.issuedAt };
}

function buildMessage(nonce, issuedAt, pubkey) {
  return `Sign in to Tashi\n\nWallet: ${pubkey}\nNonce: ${nonce}\nIssuedAt: ${issuedAt}`.trim();
}

async function getMissions(wallet, token) {
  const { data } = await http(`${BASE_WEB}/missions.api/get?wallet_id=${wallet}`, {
    headers: { cookie: `Authorization=Bearer ${token}` },
  });
  return data;
}

async function claimMission(wallet, missionId, token) {
  const { status, data } = await http(`${BASE_WEB}/missions.api/record`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `Authorization=Bearer ${token}`,
    },
    body: JSON.stringify({ wallet_id: wallet, mission_id: missionId }),
  });
  console.log(`[claimMission] Mission ${missionId} → Status ${status}`);
  return data;
}


async function runForPrivateKey(pkB58, index) {
  console.log("\n=======================================");
  console.log(`🔹 Account #${index + 1}`);
  console.log("=======================================\n");

  const keypair = makeKeypairFromPk(pkB58);
  const walletId = bs58.encode(keypair.publicKey);
  console.log("📌 Wallet:", walletId);
  if (REFERRAL) console.log("[config] TASHI_REFERRAL =", REFERRAL);

  const { nonce, issuedAt } = await getNonce();
  const msg = buildMessage(nonce, issuedAt, walletId);
  const sig = signMessage(msg, pkB58);
  const token = `${sig}.${walletId}`;

  // Ambil mission yang sudah diklaim
  const missions = await getMissions(walletId, token);
  const claimed = new Set(
    Array.isArray(missions) ? missions.map(m => m.mission_id ?? m.id).filter(id => typeof id === 'number') : []
  );

  // Ambil mission yang **benar-benar ada di JS**
  const targetIds = global.DETECTED_MISSION_IDS;
  if (targetIds.length === 0) {
    console.log("[info] Tidak ada mission untuk diklaim.");
    return;
  }

  const toClaim = targetIds.filter(id => !claimed.has(id));
  console.log("[info] Mission yang sudah diklaim:", Array.from(claimed).join(", ") || "(none)");
  console.log("[info] Mission baru untuk diklaim:", toClaim.length ? toClaim.join(", ") : "(none)");

  if (toClaim.length === 0) {
    console.log("\n✅ Semua mission sudah diklaim.");
    return;
  }

  console.log(`\n[🔥] Klaim ${toClaim.length} mission...`);
  for (const id of toClaim) {
    console.log(`➡ Klaim mission ${id}`);
    await claimMission(walletId, id, token);
    await new Promise(r => setTimeout(r, 400));
  }

  console.log("\n✅ Selesai klaim mission baru!");
}


(async () => {
  try {
    const privateKeys = loadPrivateKeys();
    if (privateKeys.length === 0) {
      console.error("❌ Tidak ada private key valid");
      process.exit(1);
    }

    // 🔥 Deteksi mission dari JS — sekali di awal
    global.DETECTED_MISSION_IDS = await fetchMissionIdsFromDashboardJS();

    let idx = 0;
    for (const pk of privateKeys) {
      try {
        await runForPrivateKey(pk, idx);
      } catch (e) {
        console.error(`\n❌ ERROR di account #${idx + 1}:`, e.message);
      }
      idx++;
      await new Promise(r => setTimeout(r, 800));
    }

    console.log("\n🎉 Semua account selesai!");
  } catch (err) {
    console.error("\n❌ FATAL ERROR:", err.message);
    process.exit(1);
  }
})();
