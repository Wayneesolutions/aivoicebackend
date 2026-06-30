// backend/src/routes/whatsapp/index.js
// Aggregates all WhatsApp outreach sub-routes under /api/whatsapp

const router = require('express').Router()

router.use('/contacts',  require('./contacts'))
router.use('/campaigns', require('./campaigns'))
router.use('/messages',  require('./messages'))
router.use('/templates', require('./templates'))
router.use('/webhooks',  require('./webhooks'))

module.exports = router
