const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  createCollection, bulkCreateCollections, getCollections, getCollection, deleteCollection,
} = require('../controllers/collection.controller');
const { protect } = require('../middleware/auth.middleware');
const { isAdmin } = require('../middleware/rbac.middleware');
const { validate } = require('../middleware/validate.middleware');

router.use(protect, isAdmin);

router.get('/', getCollections);
router.post('/', [
  body('customerId').notEmpty().withMessage('Customer ID required'),
  body('driverId').notEmpty().withMessage('Driver ID required'),
  body('scheduledDate').isISO8601().withMessage('Valid date required'),
], validate, createCollection);
router.post('/bulk', [
  body('driverId').notEmpty().withMessage('Driver ID required'),
  body('scheduledDate').isISO8601().withMessage('Valid date required'),
], validate, bulkCreateCollections);
router.get('/:id', getCollection);
router.delete('/:id', deleteCollection);

module.exports = router;
