const axios = require('axios');
const FormData = require('form-data');

// Helper function to generate slug from title
function generateSlug(title) {
    return title.toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')     // Replace spaces with hyphens
        .replace(/-+/g, '-');     // Replace multiple hyphens with a single hyphen
}

// Process episode data from MP4Hydra response
function processEpisode(episode, baseServer, serverName, serverNumber) {
    const videoUrl = `\( {baseServer} \){episode.src}`;
    const subtitles = episode.subs ? episode.subs.map(sub => ({
        label: sub.label,
        url: `\( {baseServer} \){sub.src}`
    })) : [];

    return {
        title: episode.show_title || episode.title,
        episode: episode.title,
        type: episode.type,
        quality: episode.quality || episode.label,
        videoUrl: videoUrl,
        server: serverName,
        serverNumber: serverNumber,
        subtitles: subtitles
    };
}

// Helper to score quality (higher = better) – used to pick the "best" stream
function qualityScore(quality) {
    if (!quality) return 0;
    const q = quality.toUpperCase();
    if (q.includes('4K') || q.includes('2160')) return 10;
    if (q.includes('1080')) return 8;
    if (q.includes('720')) return 6;
    if (q.includes('480')) return 4;
    return 2;
}

// Core logic to fetch and process streams (shared between normal + direct modes)
async function fetchAndProcessMP4Hydra(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    try {
        console.log(`[MP4Hydra] Fetching for TMDB ID: ${tmdbId}, Type: \( {mediaType}, S: \){seasonNum}, E:${episodeNum}`);

        const details = await getTMDBDetails(tmdbId, mediaType);
        if (!details) return { streams: [], details };

        let slug = details.slug;
        if (mediaType === 'movie' && details.year) {
            slug = `\( {details.slug}- \){details.year}`;
        }

        const formData = new FormData();
        formData.append('v', '8');
        formData.append('z', JSON.stringify([{
            s: slug,
            t: mediaType,
            se: seasonNum,
            ep: episodeNum
        }]));

        const response = await axios({
            method: 'post',
            url: 'https://mp4hydra.org/info2?v=8',
            data: formData,
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Origin': 'https://mp4hydra.org',
                'Referer': `https://mp4hydra.org/\( {mediaType}/ \){slug}`,
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin'
            },
            timeout: 10000
        });

        if (!response.data?.playlist?.length) {
            // Fallback attempts (original title, without year) – same as before
            let fallbackStreams = [];
            if (details.title !== details.original_title) {
                fallbackStreams = await tryAlternativeTitle(details, mediaType, seasonNum, episodeNum);
            }
            if (!fallbackStreams.length && mediaType === 'movie' && details.year) {
                fallbackStreams = await tryWithoutYear(details, mediaType, seasonNum, episodeNum);
            }
            return { streams: fallbackStreams, details };
        }

        const playlist = response.data.playlist;
        const servers = response.data.servers;
        const serverConfig = [
            { name: 'Beta', number: '#1' },
            { name: 'Beta#3', number: '#2' }
        ];

        const allProcessed = [];

        serverConfig.forEach(server => {
            if (!servers[server.name]) return;
            const baseServer = servers[server.name];

            if (mediaType === 'tv' && seasonNum && episodeNum) {
                const paddedS = seasonNum.toString().padStart(2, '0');
                const paddedE = episodeNum.toString().padStart(2, '0');
                const target = playlist.find(item =>
                    item.title?.toUpperCase() === `S\( {paddedS}E \){paddedE}`.toUpperCase()
                );
                if (target) {
                    const proc = processEpisode(target, baseServer, server.name, server.number);
                    allProcessed.push({ ...proc, title: details.title });
                }
            } else {
                // Movie: all items
                playlist.forEach(item => {
                    const proc = processEpisode(item, baseServer, server.name, server.number);
                    allProcessed.push({ ...proc, title: details.title });
                });
            }
        });

        // Build standard stream objects
        const streams = allProcessed.map(proc => ({
            title: `${proc.title} - ${proc.quality} [MP4Hydra ${proc.serverNumber}]`,
            url: proc.videoUrl,
            quality: proc.quality,
            provider: "mp4hydra",
            headers: { 'Referer': 'https://mp4hydra.org/' },
            subtitles: proc.subtitles?.map(s => ({ url: s.url, lang: s.label })) || []
        }));

        return { streams, details };
    } catch (error) {
        console.error(`[MP4Hydra] Error: ${error.message}`);
        return { streams: [], details: null };
    }
}

// Original full streams array export (unchanged behavior)
async function getMP4HydraStreams(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    const { streams } = await fetchAndProcessMP4Hydra(tmdbId, mediaType, seasonNum, episodeNum);
    return streams;
}

// NEW: Direct single best URL for VLC (plain string or null)
async function getMP4HydraDirectStream(tmdbId, mediaType, seasonNum = null, episodeNum = null) {
    const { streams } = await fetchAndProcessMP4Hydra(tmdbId, mediaType, seasonNum, episodeNum);

    if (!streams.length) return null;

    // Pick the best one (highest quality score, prefer first server if tie)
    const best = streams.reduce((prev, curr) => 
        qualityScore(curr.quality) > qualityScore(prev.quality) ? curr : prev
    );

    return best.url;  // Just the direct playable link (mp4 / m3u8)
}

// ──────────────────────────────────────────────
// Keep your existing fallback helpers unchanged
// (tryAlternativeTitle, tryWithoutYear, getTMDBDetails)
// ... paste them here exactly as in your original code ...

// Export both
module.exports = {
    getMP4HydraStreams,       // original – returns array for JSON
    getMP4HydraDirectStream   // new – returns single string URL or null
};
