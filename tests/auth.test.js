const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Force test env so rate limiter is bypassed and OTPs return in dev shape
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.INIT_SECRET = process.env.INIT_SECRET || 'test-init-secret';

const app = require('../src/app');
const User = require('../src/models/User');

jest.setTimeout(300000);

let mongoServer;

// Token lives in an httpOnly cookie — extract it from Set-Cookie header.
const extractCookie = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const tokenCookie = setCookie.find((c) => c.startsWith('token='));
  return tokenCookie ? tokenCookie.split(';')[0] : null;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  if (mongoServer) await mongoServer.stop();
});

describe('Authentication', () => {
  const testEmail = 'test_wm_user@example.com';
  const testPhone = '0244123456';
  let customerCookie;

  test('Creates a superadmin via init-admin with secret', async () => {
    await User.deleteOne({ role: 'superadmin' });
    const res = await request(app)
      .post('/api/v1/auth/init-admin')
      .send({ secret: process.env.INIT_SECRET });
    expect([201, 409]).toContain(res.status);
  });

  test('Rejects init-admin without valid secret', async () => {
    const res = await request(app)
      .post('/api/v1/auth/init-admin')
      .send({ secret: 'wrong' });
    expect(res.status).toBe(403);
  });

  test('Registers a new customer and sets auth cookie', async () => {
    await User.deleteOne({ email: testEmail });
    const res = await request(app)
      .post('/api/v1/auth/register')
      .field('fullName', 'Test WM User')
      .field('email', testEmail)
      .field('phone', testPhone)
      .field('password', 'TestPass123')
      .field('residentialAddress', '123 Test Street, Accra')
      .field('latitude', '5.6037')
      .field('longitude', '-0.1870')
      .field('binType', 'basic');

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.user.role).toBe('customer');
    expect(extractCookie(res)).toBeTruthy();
  });

  test('Rejects duplicate email registration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .field('fullName', 'Another User')
      .field('email', testEmail)
      .field('phone', '0244999888')
      .field('password', 'TestPass123')
      .field('residentialAddress', '456 Other Street')
      .field('latitude', '5.6037')
      .field('longitude', '-0.1870');

    expect(res.status).toBe(409);
  });

  test('Logs in successfully and returns auth cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: testEmail, password: 'TestPass123' });

    expect(res.status).toBe(200);
    customerCookie = extractCookie(res);
    expect(customerCookie).toBeTruthy();
  });

  test('Rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: testEmail, password: 'WrongPassword' });
    expect(res.status).toBe(401);
  });

  test('Returns current user profile when authenticated', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', customerCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(testEmail);
  });

  test('Rejects unauthenticated /auth/me', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  test('Forbids customer from accessing admin endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Cookie', customerCookie);
    expect(res.status).toBe(403);
  });
});

describe('Admin & RBAC hierarchy', () => {
  let adminCookie;

  test('Logs in as superadmin', async () => {
    const admin = await User.findOne({ role: 'superadmin' });
    if (!admin) return;

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: process.env.ADMIN_PASSWORD || 'Admin@123456' });

    expect(res.status).toBe(200);
    adminCookie = extractCookie(res);
    expect(adminCookie).toBeTruthy();
  });

  test('Superadmin can access admin dashboard (role hierarchy)', async () => {
    if (!adminCookie) return;
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});
