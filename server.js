const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path'); // Added for robust path handling
const app = express();

// UPDATE #1: Define the path to yt-dlp
// This line checks if the app is running in production (on Render.com).
// If yes, it looks for yt-dlp in the same directory.
// If not (running locally), it assumes yt-dlp is installed globally.
const ytdlpPath = process.env.NODE_ENV === 'production' 
  ? path.join(__dirname, 'yt-dlp')
  : 'yt-dlp';

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'YouTube Downloader API is running!' });
});

// Get video formats
app.post('/api/formats', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  // UPDATE #2: Use the ytdlpPath variable here
  exec(`${ytdlpPath} -j "${url}"`, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp error:', stderr);
      return res.status(500).json({ error: 'Failed to fetch video information' });
    }

    try {
      const data = JSON.parse(stdout);
      res.json({
        title: data.title,
        formats: data.formats.slice(0, 10).map(f => ({
          format_id: f.format_id,
          format_note: f.format_note || '',
          ext: f.ext,
          resolution: f.resolution || 'audio only',
          filesize: f.filesize,
          url: f.url
        }))
      });
    } catch (parseError) {
      console.error('Parse error:', parseError);
      res.status(500).json({ error: 'Failed to parse video information' });
    }
  });
});

// Download endpoint
app.get('/api/download', (req, res) => {
  const { url, format_id } = req.query;
  
  if (!url || !format_id) {
    return res.status(400).json({ error: 'Missing URL or format_id' });
  }

  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  
  // UPDATE #3: Use the ytdlpPath variable here too
  const ytdlp = exec(`${ytdlpPath} -f ${format_id} -o - "${url}"`);
  ytdlp.stdout.pipe(res);
  
  ytdlp.on('error', (error) => {
    console.error('Download error:', error);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
