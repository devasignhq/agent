// Diagnose a stuck escrow refund/release — read-only, NEVER signs or sends.
//
//   npx tsx scripts/diagnose-escrow.ts BNTY-10
//   npx tsx scripts/diagnose-escrow.ts BNTY-10 --release   # probe admin_release instead
//
// The keeper logs `refund for <code>: chain_error`, which is refundBounty's catch
// around chain.adminRefund(). This walks the same path (getAccount → build →
// simulate) and prints the error, plus the state that usually explains it.
//
// Reads go through the `db` helper, like seed.ts — the store is the one place
// that owns SQL. Safe against production: this script performs NO mutations, so
// shutdownDb's flush is a no-op, and the coherence poller initDb starts only ever
// SELECTs (it reconciles Postgres → memory, never writes back).
//
// Run with the SAME env as the service (STELLAR_* + DATABASE_URL).
import { config, isStellarConfigured } from "../src/config.js";
import { db, initDb, shutdownDb } from "../src/db.js";
import { adminAddress, server } from "../src/stellar/client.js";
import { buildEscrowInvoke } from "../src/stellar/build.js";
import { getEscrow } from "../src/stellar/escrow.js";
import { addressScVal, taskIdScVal } from "../src/stellar/scval.js";
import { isValidTaskId, taskIdMatchesBounty } from "../src/bounties/taskid.js";

function detail(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.message}\n    cause: ${String(cause)}` : err.message;
  }
  return String(err);
}

async function main() {
  const code = process.argv[2];
  const probeRelease = process.argv.includes("--release");
  if (!code) {
    console.error("usage: tsx scripts/diagnose-escrow.ts <BOUNTY-CODE> [--release]");
    process.exit(1);
  }
  if (!isStellarConfigured()) {
    console.error("Stellar is not configured here — the keeper would be idle in this env.");
    process.exit(1);
  }
  if (!config.databaseUrl) {
    // Without it initDb falls back to an empty in-memory store, so every lookup
    // would falsely report "no such bounty". Require the real database.
    console.error("DATABASE_URL is not set — point it at the same database as the service.");
    process.exit(1);
  }

  console.log("── config ──────────────────────────────────────────────");
  console.log(`network      ${config.stellar.network}`);
  console.log(`rpcUrl       ${config.stellar.rpcUrl}`);
  console.log(`contractId   ${config.stellar.contractId}`);
  console.log(`admin        ${adminAddress()}`);

  await initDb();
  const b = db.find("bounties", (x) => x.code === code);
  if (!b) {
    console.error(`\nNo bounty with code ${code} in this database.`);
    await shutdownDb();
    process.exit(1);
  }

  console.log("\n── bounty ──────────────────────────────────────────────");
  console.log(`id           ${b.id}`);
  console.log(`status       ${b.status}`);
  console.log(`pendingOp    ${b.pendingOp ?? "(none)"}`);
  const taskOk = isValidTaskId(b.taskId);
  const derived = taskIdMatchesBounty(b.id, b.taskId);
  const taskNote = !taskOk
    ? "*** INVALID — must be 25 base32 [A-Z2-7] chars ***"
    : derived
      ? "(valid)"
      : "*** NOT DERIVED FROM THIS BOUNTY ID — row is corrupt ***";
  console.log(`taskId       ${b.taskId} ${taskNote}`);
  console.log(`amount       ${b.amountStroops} stroops`);
  console.log(`sponsorAddr  ${b.sponsorAddress ?? "(none)"}`);
  console.log(`assigneeAddr ${b.assigneeAddress ?? "(none)"}`);
  console.log(`deadlineAt   ${b.deadlineAt ? new Date(b.deadlineAt).toISOString() : "(none)"}`);
  console.log(`extension    ${b.extension ? `${b.extension.status} (+${b.extension.days}d)` : "(none)"}`);

  const txns = db.filter("escrowTransactions", (t) => t.bountyId === b.id);
  console.log(`\n── escrowTransactions (${txns.length}) ─────────────────────────`);
  if (!txns.length) {
    console.log("(none — a refund that throws before insertTxn leaves NO row, which is");
    console.log(" why this failure is invisible outside the logs)");
  }
  for (const t of txns) {
    console.log(`${t.kind.padEnd(7)} ${t.status.padEnd(8)} ${t.idempotencyKey}`);
    console.log(`        hash=${t.hash ?? "-"} error=${t.error ?? "-"}`);
  }

  console.log("\n── admin account ───────────────────────────────────────");
  try {
    const acct = await server().getAccount(adminAddress());
    console.log(`exists, sequence ${acct.sequenceNumber()}`);
  } catch (err) {
    console.log(`*** getAccount FAILED: ${detail(err)}`);
    console.log("    → this alone produces chain_error every tick (missing account, or RPC down).");
  }
  try {
    const res = await fetch(`${config.stellar.horizonUrl.replace(/\/+$/, "")}/accounts/${adminAddress()}`);
    if (res.ok) {
      const body = (await res.json()) as { balances?: Array<{ asset_type?: string; balance?: string }> };
      console.log(`XLM balance  ${body.balances?.find((x) => x.asset_type === "native")?.balance ?? "?"}`);
    } else {
      console.log(`Horizon says ${res.status} for the admin account`);
    }
  } catch (err) {
    console.log(`Horizon lookup failed: ${detail(err)}`);
  }

  console.log("\n── on-chain escrow ─────────────────────────────────────");
  if (!taskOk) {
    console.log("skipped — taskId is malformed, which is itself the cause.");
  } else {
    try {
      const escrow = await getEscrow(b.taskId);
      if (escrow === null) {
        console.log("*** get_escrow returned NO escrow for this task_id.");
        console.log("    → nothing on-chain to refund; admin_refund will revert forever.");
      } else {
        console.log(JSON.stringify(escrow, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      }
    } catch (err) {
      console.log(`*** get_escrow threw: ${detail(err)}`);
    }
  }

  const method = probeRelease ? "admin_release" : "admin_refund";
  console.log(`\n── simulating ${method} (build + simulate only, nothing is sent) ──`);
  try {
    if (probeRelease) {
      if (!b.assigneeAddress) throw new Error("bounty has no assigneeAddress to release to");
      await buildEscrowInvoke(adminAddress(), "admin_release", [
        taskIdScVal(b.taskId),
        addressScVal(b.assigneeAddress),
      ]);
    } else {
      await buildEscrowInvoke(adminAddress(), "admin_refund", [taskIdScVal(b.taskId)]);
    }
    console.log("simulation SUCCEEDED — the tx builds and signs cleanly.");
    console.log("→ the failure was transient (RPC blip); the next keeper tick should settle it.");
  } catch (err) {
    console.log(`*** THIS IS THE SWALLOWED ERROR:\n    ${detail(err)}`);
    console.log("\n    Common readings:");
    console.log("    • 'Account not found'                → admin account missing on this network (wrong STELLAR_NETWORK / rotated key)");
    console.log("    • 'MissingValue' / unknown function  → deployed contract has no admin_refund — redeploy the contract");
    console.log("    • 'Error(Contract, #N)'              → contract rejected it: wrong admin, already settled, or bad status");
    console.log("    • 'task_id must be exactly 25 base32'→ the bounty row's taskId is corrupt");
  }

  await shutdownDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
