// Rewrap every member data key under the active master key, then report which master keys are still needed.
//   MASTER_KEYS="k1:<hex>,k2:<hex>" MASTER_KEY_ACTIVE=k2 DATABASE_URL=... npm run rotate-keys
// The old key may be destroyed only after this reports it unused AND every database backup that still needs it has
// expired or been destroyed (docs/key-management.md). Nothing here deletes a key.
import { KeyStore } from "./crypto.js";
import { loadKeyProvider } from "./vault-provider.js";
import { openDb } from "./db.js";

const provider = await loadKeyProvider(process.env);
if (!provider) throw new Error("Set MASTER_KEYS (and MASTER_KEY_ACTIVE) or MASTER_KEY_HEX.");
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL: rotation works on the real database.");

const db = await openDb(process.env.DATABASE_URL);
const keys = new KeyStore(db, provider, Buffer.alloc(32)); // the pepper is not used here
console.log(`Active master key: ${provider.activeId}`);
console.log("Before:", await keys.keyUsage());
const r = await keys.rewrapAll();
console.log(`Rewrapped ${r.rewrapped}; ${r.remaining} still under another key.`);
console.log("After:", await keys.keyUsage());
await db.close();
if (r.remaining) process.exitCode = 1;
