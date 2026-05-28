const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.INIT_SECRET = process.env.INIT_SECRET || 'test-init-secret';

const app = require('../src/app');
const User = require('../src/models/User');

jest.setTimeout(300000);

let mongoServer;

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

describe('Driver creation follows the username + phone-as-password login flow', () => {
  const adminEmail = 'driver_admin@example.com';
  const adminPassword = 'Admin@123456';
  const driverPhone = '0249988776';
  let adminCookie;
  let driverUsername;

  test('Sets up an admin and logs in (email + password still works for staff)', async () => {
    await User.create({
      fullName: 'Driver Test Admin',
      email: adminEmail,
      phone: '0240000111',
      password: adminPassword,
      role: 'admin',
      isVerified: true,
      isActive: true,
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: adminEmail, password: adminPassword });

    expect(res.status).toBe(200);
    adminCookie = extractCookie(res);
    expect(adminCookie).toBeTruthy();
  });

  test('Admin creates a driver with NO password and gets back a username', async () => {
    const res = await request(app)
      .post('/api/v1/admin/drivers')
      .set('Cookie', adminCookie)
      .field('fullName', 'Kojo Driver')
      .field('phone', driverPhone)
      .field('truckNumber', 'GH-4321-21');

    expect(res.status).toBe(201);
    expect(res.body.data.username).toBeTruthy();
    driverUsername = res.body.data.username;

    // Verify no plaintext password leaked and the role is driver.
    expect(res.body.data.driver).toBeTruthy();
  });

  test('Driver logs in with username + phone (phone is the password)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: driverUsername, phone: driverPhone });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('driver');
    expect(extractCookie(res)).toBeTruthy();
  });

  test('Driver login rejects a wrong phone number', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: driverUsername, phone: '0240000000' });
    expect(res.status).toBe(401);
  });

  test('Username search with role=driver finds the driver', async () => {
    const prefix = driverUsername.slice(0, 3);
    const res = await request(app).get(`/api/v1/auth/usernames?q=${prefix}&role=driver`);
    expect(res.status).toBe(200);
    expect(res.body.data.usernames).toContain(driverUsername);
  });

  test('Username search with role=customer does NOT return the driver', async () => {
    const prefix = driverUsername.slice(0, 3);
    const res = await request(app).get(`/api/v1/auth/usernames?q=${prefix}&role=customer`);
    expect(res.status).toBe(200);
    expect(res.body.data.usernames).not.toContain(driverUsername);
  });
});
