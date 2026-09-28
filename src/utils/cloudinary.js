const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

cloudinary.config({
  cloud_name: 'daoummcel',
  api_key: '359941915345927',
  api_secret: 'my0lB_-mevYyarmob6sZsa4fquo',
});

async function uploadBufferToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    if (!buffer || buffer.length === 0) {
      return reject(new Error('Invalid buffer'));
    }

    const isPdf =
      (typeof filename === 'string' && filename.toLowerCase().endsWith('.pdf')) ||
      (buffer.length >= 4 &&
        buffer[0] === 0x25 && // %
        buffer[1] === 0x50 && // P
        buffer[2] === 0x44 && // D
        buffer[3] === 0x46); // F

    const opts = { resource_type: 'auto', folder: 'inventory' };
    if (filename) {
      const sanitized = filename
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/\.[^/.]+$/, '')
        .replace(/^_+|_+$/g, '') || (isPdf ? 'document' : 'asset');
      const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      opts.public_id = `${sanitized}_${uniqueSuffix}`;
    }
    if (isPdf) {
      opts.format = 'pdf';
    }
    const uploadStream = cloudinary.uploader.upload_stream(opts, (error, result) => {
      if (error) {
        console.error('Cloudinary upload error:', error);
        return reject(error);
      }
      resolve(result.secure_url || result.url);
    });
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

module.exports = { uploadBufferToCloudinary };
