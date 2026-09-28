const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type: only images are allowed'));
    }
  }
});
const { uploadBufferToCloudinary } = require('../utils/cloudinary');

router.post('/', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const cloudinaryUrl = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname || 'file');
    res.json({ cloudinaryUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
