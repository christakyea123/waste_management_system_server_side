const multer = require('multer');
const ApiResponse = require('../utils/apiResponse');

// Use memory storage — files are buffered in RAM and then
// uploaded to Cloudinary from the controller.
const memStorage = multer.memoryStorage();

const fileFilter = (allowedTypes) => (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
};

const imageFilter = fileFilter(['image/jpeg', 'image/png', 'image/webp', 'image/jpg']);
const docFilter = fileFilter(['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'application/pdf']);

const uploadProfile = multer({
  storage: memStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: imageFilter,
});

const uploadEvidence = multer({
  storage: memStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: imageFilter,
});

const uploadDocument = multer({
  storage: memStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: docFilter,
});

// Multer error handler
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return ApiResponse.error(res, 'File size too large. Maximum allowed size is 10MB.', 400);
    }
    return ApiResponse.error(res, err.message, 400);
  }
  if (err) {
    return ApiResponse.error(res, err.message || 'File upload failed', 400);
  }
  next();
};

module.exports = { uploadProfile, uploadEvidence, uploadDocument, handleMulterError };
