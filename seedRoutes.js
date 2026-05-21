/**
 * One-time seed script — populates the 10 Dunkwa-on-Offin routes.
 * Run with: node seedRoutes.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Route = require('./src/models/Route');

const ROUTES = [
  { name: 'Mfoum',                  zone: 'Dunkwa on Offin', description: 'Mfoum community area' },
  { name: 'Estate',                 zone: 'Dunkwa on Offin', description: 'Estate residential area' },
  { name: 'Oxford',                 zone: 'Dunkwa on Offin', description: 'Oxford area' },
  { name: 'Abesewa',                zone: 'Dunkwa on Offin', description: 'Abesewa community' },
  { name: 'Kadadwene / Zongo',      zone: 'Dunkwa on Offin', description: 'Kadadwene and Zongo areas' },
  { name: 'Buzagaline',             zone: 'Dunkwa on Offin', description: 'Buzagaline area' },
  { name: 'Main Market / Low Cost', zone: 'Dunkwa on Offin', description: 'Main market and low cost area' },
  { name: 'Atecham',                zone: 'Dunkwa on Offin', description: 'Atecham community' },
  { name: 'Dunkwa Soro',            zone: 'Dunkwa on Offin', description: 'Dunkwa Soro area' },
  { name: 'Atecham Police',         zone: 'Dunkwa on Offin', description: 'Atecham Police area' },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  let created = 0;
  let skipped = 0;

  for (const r of ROUTES) {
    const exists = await Route.findOne({ name: r.name, zone: r.zone });
    if (exists) {
      console.log(`  SKIP  ${r.name} (already exists)`);
      skipped++;
    } else {
      await Route.create({ ...r, isActive: true });
      console.log(`  ADD   ${r.name}`);
      created++;
    }
  }

  console.log(`\nDone — ${created} created, ${skipped} skipped.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
