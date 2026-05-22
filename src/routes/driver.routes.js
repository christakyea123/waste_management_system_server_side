const express = require('express');
const router = express.Router();
const {
  getDashboard, getAssignedCustomers, getCollections, getCollectionsSummary,
  updateCollectionStatus, updateLocation,
} = require('../controllers/driver.controller');
const { protect } = require('../middleware/auth.middleware');
const { isDriver } = require('../middleware/rbac.middleware');
const { uploadEvidence, handleMulterError } = require('../middleware/upload.middleware');

router.use(protect, isDriver);

router.get('/dashboard', getDashboard);
router.get('/customers', getAssignedCustomers);
router.get('/collections', getCollections);
router.get('/collections/summary', getCollectionsSummary);
router.put('/collections/:id', uploadEvidence.single('evidencePhoto'), handleMulterError, updateCollectionStatus);
router.put('/location', updateLocation);

module.exports = router;
