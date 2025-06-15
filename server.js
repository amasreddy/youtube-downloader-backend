
// Backend Server Code (Node.js + Express)
// Save this as server.js and run separately from your React app
// 
// Installation: npm install express multer cors helmet express-rate-limit child_process
// Usage: node server.js

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Add JSON parsing middleware
app.use(express.json());

// Create uploads directory if it doesn't exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Rate limiting
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 uploads per windowMs
  message: 'Too many uploads, please try again later'
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 downloads per windowMs
  message: 'Too many downloads, please try again later'
});

// YouTube-specific rate limiter
const youtubeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 YouTube requests per windowMs
  message: 'Too many YouTube requests, please try again later'
});

// yt-dlp path configuration
const ytdlpPath = process.env.NODE_ENV === 'production' ? './yt-dlp' : 'yt-dlp';

// NEW: YouTube video formats endpoint
app.post('/api/formats', youtubeLimiter, async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate YouTube URL
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    if (!youtubeRegex.test(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log(`Fetching video info for: ${url}`);

    // Get video information and formats
    const { stdout } = await execPromise(`${ytdlpPath} -j "${url}"`);
    const videoInfo = JSON.parse(stdout);

    // Filter and format the available formats
    const formats = videoInfo.formats
      .filter(format => format.url && (format.vcodec !== 'none' || format.acodec !== 'none'))
      .map(format => ({
        format_id: format.format_id,
        format_note: format.format_note,
        ext: format.ext,
        resolution: format.resolution || (format.acodec !== 'none' && format.vcodec === 'none' ? 'audio only' : undefined),
        filesize: format.filesize,
        url: format.url
      }))
      .sort((a, b) => {
        // Sort by quality: video formats first, then audio
        if (a.resolution === 'audio only' && b.resolution !== 'audio only') return 1;
        if (a.resolution !== 'audio only' && b.resolution === 'audio only') return -1;
        return 0;
      });

    res.json({
      title: videoInfo.title,
      formats: formats
    });

  } catch (error) {
    console.error('YouTube fetch error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch video information. Please check the URL and try again.' 
    });
  }
});

// NEW: YouTube video download endpoint
app.get('/api/download', youtubeLimiter, async (req, res) => {
  try {
    const { url, format_id } = req.query;
    
    if (!url || !format_id) {
      return res.status(400).json({ error: 'URL and format_id are required' });
    }

    console.log(`Starting download for: ${url} with format: ${format_id}`);

    // Get download URL for the specific format
    const { stdout } = await execPromise(`${ytdlpPath} -f ${format_id} -g "${url}"`);
    const downloadUrl = stdout.trim();

    // Redirect to the actual download URL
    res.redirect(downloadUrl);

  } catch (error) {
    console.error('YouTube download error:', error);
    res.status(500).json({ 
      error: 'Failed to process download. Please try again.' 
    });
  }
});

// ... keep existing code (multer configuration, file metadata storage, upload endpoint, download endpoint, file info endpoint, health check, error handling middleware)

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    // Generate unique filename
    const uniqueId = crypto.randomUUID();
    cb(null, uniqueId);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept all file types since files are encrypted
    cb(null, true);
  }
});

// File metadata storage (in production, use a database)
const fileMetadata = new Map();

// Upload endpoint
app.post('/api/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileId = req.file.filename;
    const originalName = req.body.originalName || 'unknown';
    
    // Store metadata
    fileMetadata.set(fileId, {
      originalName,
      uploadDate: new Date(),
      filePath: req.file.path,
      size: req.file.size
    });

    // Schedule file deletion after 7 days
    setTimeout(async () => {
      try {
        await fs.unlink(req.file.path);
        fileMetadata.delete(fileId);
        console.log(`Auto-deleted file: ${fileId}`);
      } catch (error) {
        console.error(`Failed to auto-delete file ${fileId}:`, error);
      }
    }, 7 * 24 * 60 * 60 * 1000); // 7 days

    res.json({
      fileId,
      message: 'File uploaded successfully'
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Download endpoint
app.get('/api/download/:fileId', downloadLimiter, async (req, res) => {
  try {
    const { fileId } = req.params;
    
    // Check if file exists in metadata
    const metadata = fileMetadata.get(fileId);
    if (!metadata) {
      return res.status(404).json({ error: 'File not found or has expired' });
    }

    // Check if file still exists on disk
    try {
      await fs.access(metadata.filePath);
    } catch (error) {
      fileMetadata.delete(fileId);
      return res.status(404).json({ error: 'File not found or has expired' });
    }

    // Set headers
    res.setHeader('X-Original-Filename', metadata.originalName);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName}"`);

    // Stream the file
    const fileStream = require('fs').createReadStream(metadata.filePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// File info endpoint (optional)
app.get('/api/info/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const metadata = fileMetadata.get(fileId);
    
    if (!metadata) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      originalName: metadata.originalName,
      uploadDate: metadata.uploadDate,
      size: metadata.size
    });

  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ error: 'Failed to get file info' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large (max 2GB)' });
    }
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload directory: ${UPLOADS_DIR}`);
  console.log(`YouTube downloader endpoints available at /api/formats and /api/download`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
