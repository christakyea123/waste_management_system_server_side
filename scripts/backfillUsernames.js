/**
 * One-time migration: give every existing customer & driver a login `username`.
 *
 * Why: the login flow switched to "username + phone (phone is the password)".
 * The username branch matches the entered phone against the account's stored
 * `phone` field — NOT the password hash — so existing users only need a
 * username generated; their passwords are left untouched. Admins/superadmins
 * keep email+password login and are skipped.
 *
 * Usage:
 *   node scripts/backfillUsernames.js            # DRY RUN — prints what it would do
 *   node scripts/backfillUsernames.js --apply    # actually write usernames
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
const logger = require('../src/utils/logger');

const APPLY = process.argv.includes('--apply');

(async () => {
  await connectDB();

  const targets = await User.find({
    role: { $in: ['customer', 'driver'] },
    $or: [{ username: { $exists: false } }, { username: null }],
  }).select('_id fullName phone role username');

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${targets.length} user(s) without a username\n`);

  let done = 0;
  for (const u of targets) {
    const username = await User.generateUniqueUsername(u.fullName);
    console.log(`  ${u.role.padEnd(8)} ${String(u.fullName || '').padEnd(24)} ${u.phone} -> ${username}`);
    if (APPLY) {
      // updateOne avoids the password-hash pre-save hook entirely (we never want
      // to re-hash an already-hashed password by saving the full document).
      await User.updateOne({ _id: u._id }, { $set: { username } });
      done++;
    }
  }

  if (APPLY) {
    logger.info(`backfillUsernames: set username on ${done} user(s)`);
    console.log(`\n✔ Done — ${done} username(s) written.\n`);
  } else {
    console.log(`\nDry run only. Re-run with --apply to write these usernames.\n`);
  }

  await mongoose.connection.close();
  process.exit(0);
})().catch(async (err) => {
  console.error('backfillUsernames failed:', err.message);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
