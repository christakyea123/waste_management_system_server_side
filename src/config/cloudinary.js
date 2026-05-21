const cloudinary = require('cloudinary').v2;
const logger = require('../utils/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Unsigned upload preset ──────────────────────────────────────
// Unsigned uploads skip timestamp/signature validation entirely,
// which avoids "Stale request" errors when the server clock drifts.
const PRESET_NAME = 'wm_unsigned';
let presetReady = false;

const ensureUnsignedPreset = async () => {
  if (presetReady) return;
  try {
    await cloudinary.api.upload_preset(PRESET_NAME);
    presetReady = true;
    logger.info('Cloudinary unsigned preset found');
  } catch (err) {
    if (err.error && err.error.http_code === 404) {
      try {
        await cloudinary.api.create_upload_preset({
          name: PRESET_NAME,
          unsigned: true,
          folder: 'waste_management',
        });
        presetReady = true;
        logger.info('Cloudinary unsigned preset created');
      } catch (createErr) {
        logger.error(`Failed to create Cloudinary preset: ${createErr.message}`);
      }
    } else {
      logger.error(`Failed to check Cloudinary preset: ${err.message}`);
    }
  }
};

// Run on import (non-blocking)
ensureUnsignedPreset();

// ── Upload helper ───────────────────────────────────────────────
// Accepts a multer file (memoryStorage buffer) and uploads to Cloudinary
// using unsigned upload (no timestamp required).
// Note: unsigned uploads only allow: folder, tags, public_id, context.
// Transformations are applied via URL when displaying the image.
const uploadToCloudinary = (fileBuffer, folder = 'waste_management/profiles') => {
  return new Promise((resolve, reject) => {
    const dataUri = `data:image/jpeg;base64,${fileBuffer.toString('base64')}`;

    cloudinary.uploader.unsigned_upload(dataUri, PRESET_NAME, {
      folder,
      resource_type: 'image',
    }, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });
};

module.exports = { cloudinary, uploadToCloudinary, ensureUnsignedPreset };
