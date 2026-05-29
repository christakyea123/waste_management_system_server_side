const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Invoice = require('../src/models/Invoice');
require('../src/models/Settings'); // registered so Customer's pre-save pricing hook works
const invoiceService = require('../src/services/invoice.service');

jest.setTimeout(300000);

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  if (mongoServer) await mongoServer.stop();
});

const now = new Date();
const MONTH = now.getMonth() + 1;
const YEAR = now.getFullYear();

describe('Billing excludes staff (admin/superadmin) from the payment plan', () => {
  test('A real customer DOES get a monthly invoice', async () => {
    const user = await User.create({
      fullName: 'Real Customer', phone: '0244000111', password: '0244000111',
      username: 'real.customer10', role: 'customer',
    });
    const customer = await Customer.create({
      user: user._id, residentialAddress: '1 Test St', area: 'Mfoum',
      location: { type: 'Point', coordinates: [-0.18, 5.6] }, binType: 'standard', accountStatus: 'active',
    });

    const inv = await invoiceService.ensureMonthlyInvoice(customer._id, MONTH, YEAR);
    expect(inv).toBeTruthy();
    expect(await Invoice.countDocuments({ customer: customer._id })).toBe(1);
  });

  test('A superadmin with a leftover customer profile is NOT billed', async () => {
    const user = await User.create({
      fullName: 'Owner Admin', phone: '0244000222', password: 'Admin@123456',
      username: 'owner.admin11', role: 'superadmin',
    });
    const customer = await Customer.create({
      user: user._id, residentialAddress: '2 Admin St', area: 'Estate',
      location: { type: 'Point', coordinates: [-0.18, 5.6] }, binType: 'standard', accountStatus: 'active',
    });

    const inv = await invoiceService.ensureMonthlyInvoice(customer._id, MONTH, YEAR);
    expect(inv).toBeNull();
    expect(await Invoice.countDocuments({ customer: customer._id })).toBe(0);
  });

  test('A plain admin with a customer profile is NOT billed', async () => {
    const user = await User.create({
      fullName: 'Plain Admin', phone: '0244000333', password: 'Admin@123456',
      username: 'plain.admin12', role: 'admin',
    });
    const customer = await Customer.create({
      user: user._id, residentialAddress: '3 Admin St', area: 'Oxford',
      location: { type: 'Point', coordinates: [-0.18, 5.6] }, binType: 'premium', accountStatus: 'active',
    });

    const inv = await invoiceService.ensureMonthlyInvoice(customer._id, MONTH, YEAR);
    expect(inv).toBeNull();
    expect(await Invoice.countDocuments({ customer: customer._id })).toBe(0);
  });
});
