// backend/src/services/storage.js
// Unified file storage — uses S3 in production, local disk in dev
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const fs   = require('fs')
const path = require('path')

const USE_S3 = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY &&
                  process.env.AWS_S3_BUCKET && !process.env.AWS_ACCESS_KEY_ID.includes('YOUR_'))

const s3 = USE_S3 ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
}) : null

console.log(`[storage] Using ${USE_S3 ? 'S3' : 'local disk'} for file uploads`)

/**
 * Upload a file buffer to S3 or local disk.
 * @returns {string} public URL of the uploaded file
 */
async function uploadFile({ buffer, mimetype, filename, folder = 'uploads' }) {
  if (USE_S3) {
    const key = `${folder}/${filename}`
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.AWS_S3_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimetype,
    }))
    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`
  }

  // Local disk fallback
  const dir     = path.join(__dirname, '../../uploads', folder)
  fs.mkdirSync(dir, { recursive: true })
  const fullPath = path.join(dir, filename)
  fs.writeFileSync(fullPath, buffer)
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`
  return `${baseUrl}/uploads/${folder}/${filename}`
}

/**
 * Delete a file by its public URL.
 */
async function deleteFile(url) {
  if (!url) return
  try {
    if (USE_S3) {
      const bucket = process.env.AWS_S3_BUCKET
      const key = url.split(`${bucket}.s3`)[1]?.replace(/^[^/]*\//, '')
      if (key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      return
    }
    // Local disk
    const localPath = path.join(__dirname, '../../', url.replace(/^https?:\/\/[^/]+\//, ''))
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath)
  } catch (e) {
    console.warn('[storage] deleteFile failed:', e.message)
  }
}

module.exports = { uploadFile, deleteFile }
