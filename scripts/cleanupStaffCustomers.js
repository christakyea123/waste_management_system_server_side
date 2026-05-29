/**
 * Remove "customer" artifacts for staff (admin/superadmin) users.
 *
 * Why: a superadmin/admin is not a paying customer, but one may have a leftover
 * Customer profile + invoices (e.g. they registered to test, then were promoted).
 * This deletes those Customer docs and their invoices/collections so staff never
 * appear on a payment plan or in the customers list.
 *
 * Usage:
 *   node scripts/cleanupStaffCustomers.js          # DRY RUN — shows what it would delete
 *   node scripts/cleanupStaffCustomers.js --apply  # actually delete
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Invoice = require('../src/models/Invoice');
const Collection = require('../src/models/Collection');
const Payment = require('../src/models/Payment');

const APPLY = process.argv.includes('--apply');

(async () => {
  await connectDB();

  const staff = await User.find({ role: { $in: ['admin', 'superadmin'] } }).select('_id fullName role').lean();
  const staffIds = staff.map((s) => s._id);
  const staffCustomers = await Customer.find({ user: { $in: staffIds } }).lean();

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${staffCustomers.length} staff customer profile(s) found\n`);

  let delC = 0, delI = 0, delCol = 0, delP = 0;
  for (const c of staffCustomers) {
    const owner = staff.find((s) => String(s._id) === String(c.user));
    const invoices = await Invoice.countDocuments({ customer: c._id });
    const collections = await Collection.countDocuments({ customer: c._id });
    const payments = await Payment.countDocuments({ customer: c._id });
    console.log(`  ${c.customerId} (${owner ? owner.role + ' ' + owner.fullName : 'unknown'}) -> invoices=${invoices}, collections=${collections}, payments=${payments}`);

    if (APPLY) {
      const i = await Invoice.deleteMany({ customer: c._id });
      const col = await Collection.deleteMany({ customer: c._id });
      const p = await Payment.deleteMany({ customer: c._id });
      await Customer.deleteOne({ _id: c._id });
      delC += 1; delI += i.deletedCount || 0; delCol += col.deletedCount || 0; delP += p.deletedCount || 0;
    }
  }

  if (APPLY) {
    console.log(`\n✔ Deleted ${delC} customer profile(s), ${delI} invoice(s), ${delCol} collection(s), ${delP} payment(s).`);
    console.log('  (Staff user accounts themselves are untouched — they can still log in as admin.)\n');
  } else if (staffCustomers.length) {
    console.log(`\nDry run only. Re-run with --apply to delete the above.\n`);
  } else {
    console.log('Nothing to clean up.\n');
  }

  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
