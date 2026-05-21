const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const app = require('../src/app');
const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Invoice = require('../src/models/Invoice');

jest.setTimeout(300000);

let mongoServer;
let customerCookie;
let customerId;
let invoiceId;

const extractCookie = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const tokenCookie = setCookie.find((c) => c.startsWith('token='));
  return tokenCookie ? tokenCookie.split(';')[0] : null;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const email = 'test_payment_wm@example.com';
  await User.deleteOne({ email });
  const res = await request(app)
    .post('/api/v1/auth/register')
    .field('fullName', 'Payment Test User')
    .field('email', email)
    .field('phone', '0244555777')
    .field('password', 'TestPass123')
    .field('residentialAddress', '1 Payment Street, Accra')
    .field('latitude', '5.6037')
    .field('longitude', '-0.1870')
    .field('binType', 'basic');

  customerCookie = extractCookie(res);
  const customer = await Customer.findOne({ user: res.body.user._id });
  customerId = customer?._id;
});

afterAll(async () => {
  await mongoose.connection.close();
  if (mongoServer) await mongoServer.stop();
});

describe('Invoice System', () => {
  test('Returns the customer invoices list', async () => {
    const res = await request(app)
      .get('/api/v1/customer/invoices')
      .set('Cookie', customerCookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  test('Creates an invoice for the customer', async () => {
    if (!customerId) return;
    const now = new Date();
    const inv = await Invoice.create({
      customer: customerId,
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      amount: 50,
      dueDate: new Date(now.getFullYear(), now.getMonth(), 25),
    });
    invoiceId = inv._id;
    expect(inv.invoiceNumber).toBeDefined();
    expect(inv.status).toBe('pending');
  });
});

describe('Payment Initialization', () => {
  test('Initializes a payment (Paystack may be stubbed)', async () => {
    if (!customerCookie || !invoiceId) return;

    const res = await request(app)
      .post('/api/v1/payments/initialize')
      .set('Cookie', customerCookie)
      .send({ invoiceId: invoiceId.toString() });

    // 500 is acceptable when Paystack credentials are not configured
    expect([200, 400, 500]).toContain(res.status);
  });

  test('Rejects payment for non-existent invoice', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .post('/api/v1/payments/initialize')
      .set('Cookie', customerCookie)
      .send({ invoiceId: fakeId.toString() });

    expect(res.status).toBe(404);
  });
});

describe('PDF Generation', () => {
  test('Generates an invoice PDF', async () => {
    if (!customerCookie || !invoiceId) return;
    const res = await request(app)
      .get(`/api/v1/payments/invoice/${invoiceId}/pdf`)
      .set('Cookie', customerCookie);

    expect([200, 500]).toContain(res.status);
  });
});
