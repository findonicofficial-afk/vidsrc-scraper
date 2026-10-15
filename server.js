import express from 'express';
import cors from 'cors';
import { VidSrcScraper } from '@definisi/vidsrc-scraper';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Scraper instance launch karein (Koi heavy browser nahi chahiye!)
const scraper = new VidSrcScraper();

app.get('/', (req, res) => {
    res.send('🚀 Fast VidSrc API is Running Successfully Without Browser Automation.');
});

// Main extractor endpoint
app.get('/extract', async (req, res) => {
    const { tmdb_id, type, season, episode } = req.query;

    if (!tmdb_id) {
        return res.status(400).json({ success: false, error: "tmdb_id query parameter is required." });
    }

    try {
        console.log(`[Scraper] Extracting streams for TMDB ID: ${tmdb_id}`);
        let streams = [];

        if (type === 'tv') {
            if (!season || !episode) {
                return res.status(400).json({ success: false, error: "season and episode are required for TV shows." });
            }
            // TV Show ke streams fetch karein
            streams = await scraper.getShowStreams(tmdb_id, parseInt(season), parseInt(episode));
        } else {
            // Movie ke streams fetch karein
            streams = await scraper.getMovieStreams(tmdb_id);
        }

        if (streams && streams.length > 0) {
            res.json({
                success: true,
                results: streams
            });
        } else {
            res.json({
                success: false,
                message: "No streams found for this content.",
                results: []
            });
        }

    } catch (error) {
        console.error("Scraping Error:", error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            results: []
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running instantly on port ${PORT}`);
});
