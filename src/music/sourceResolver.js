import { execFile, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { LRUCache } from '../utils/helpers.js';
import { config } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const LAVALINK_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const YTDLP_CACHE_TTL = 30 * 60 * 1000;       // 30 min (direct URLs expire)
const trackCache = new LRUCache(200, LAVALINK_CACHE_TTL);

// ─── URL Pattern Detection ─────────────────────────────────────
const YOUTUBE_VIDEO_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
const YOUTUBE_PLAYLIST_RE = /(?:youtube\.com\/(?:playlist\?|watch\?.*&?)list=)([a-zA-Z0-9_-]+)/i;
const SPOTIFY_TRACK_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/i;
const SPOTIFY_COLLECTION_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album)\/([a-zA-Z0-9]+)/i;
const SOUNDCLOUD_RE = /soundcloud\.com\//i;
const SOUNDCLOUD_SET_RE = /soundcloud\.com\/[^/]+\/sets\//i;

/**
 * Classify a query into its type for optimal Lavalink routing
 */
function classifyQuery(query) {
    if (!isURL(query)) return 'search';
    if (SPOTIFY_COLLECTION_RE.test(query)) return 'spotify_collection';
    if (SPOTIFY_TRACK_RE.test(query)) return 'spotify_track';
    if (YOUTUBE_PLAYLIST_RE.test(query)) return 'youtube_playlist';
    if (YOUTUBE_VIDEO_RE.test(query)) return 'youtube_video';
    if (SOUNDCLOUD_SET_RE.test(query)) return 'soundcloud_set';
    if (SOUNDCLOUD_RE.test(query)) return 'soundcloud';
    return 'url';
}

/**
 * Normalize a text query for better search results.
 * Strips noise words, extra metadata, and normalizes whitespace.
 */
function normalizeSearchQuery(query) {
    let q = query.trim();
    // Remove common noise that hurts search accuracy
    q = q.replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?\s*video|audio\s*only|full\s*video|hd|hq|4k|1080p|720p|360p|mv|visuali[sz]er|animated\s*video)\b/gi, '');
    // Remove noise in parentheses/brackets
    q = q.replace(/\((?:official|audio|video|hd|hq|lyrics?|visuali[sz]er|animated|explicit|clean|dirty|remastered|music\s*video|feat\.?.*?)\)/gi, '');
    q = q.replace(/\[(?:official|audio|video|hd|hq|lyrics?|visuali[sz]er|animated|explicit|clean|dirty|remastered|music\s*video|feat\.?.*?)\]/gi, '');
    // Remove trailing " - Topic" from artist names in queries
    q = q.replace(/\s*-\s*Topic\b/gi, '');
    // Remove VEVO suffix
    q = q.replace(/VEVO\b/gi, '');
    // Collapse whitespace
    q = q.replace(/\s+/g, ' ').trim();
    return q || query.trim();
}

/**
 * Pick the best search result using quality/relevance scoring.
 * Penalizes karaoke, nightcore, bass boosted, etc.
 * Rewards official sources, correct duration, title/artist match.
 */
function pickBestSearchResult(tracks, query) {
    if (!tracks || tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0];

    const queryLower = query.toLowerCase()
        .replace(/^(?:ytsearch:|scsearch:|spsearch:)/i, '');  // strip search prefix
    const parts = queryLower.split(/\s*[-–—]\s*/);
    const queryArtist = parts.length > 1 ? parts[0].trim() : '';
    const queryTitle = parts.length > 1 ? parts.slice(1).join(' ').trim() : queryLower;
    // Also try "title by artist" pattern
    const byParts = queryLower.split(/\s+by\s+/i);
    const queryTitleAlt = byParts.length > 1 ? byParts[0].trim() : '';
    const queryArtistAlt = byParts.length > 1 ? byParts[1].trim() : '';
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    let bestScore = -999;
    let bestTrack = tracks[0];

    for (const track of tracks.slice(0, 10)) {
        let score = 0;
        const title = (track.info?.title || '').toLowerCase();
        const author = (track.info?.author || '').toLowerCase();
        const length = track.info?.length || 0;
        // Clean title for comparison (strip parenthetical noise)
        const titleClean = title
            .replace(/\((?:official|audio|video|lyrics?|visuali[sz]er|music\s*video|feat\.?[^)]*)\)/gi, '')
            .replace(/\[(?:official|audio|video|lyrics?|visuali[sz]er|music\s*video|feat\.?[^)]*)\]/gi, '')
            .replace(/\s+/g, ' ').trim();

        // ── EXACT MATCH (highest priority — this IS the requested song) ──
        if (queryTitle && queryArtist) {
            // Both artist and title match = near-perfect match
            if ((titleClean.includes(queryTitle) || title.includes(queryTitle)) &&
                (author.includes(queryArtist) || title.includes(queryArtist))) {
                score += 25;
            }
        } else if (queryTitleAlt && queryArtistAlt) {
            if ((titleClean.includes(queryTitleAlt) || title.includes(queryTitleAlt)) &&
                (author.includes(queryArtistAlt) || title.includes(queryArtistAlt))) {
                score += 25;
            }
        }

        // ── Title matching ──
        if (queryTitle && queryTitle.length > 3 && (titleClean.includes(queryTitle) || title.includes(queryTitle))) {
            score += 15;
        } else if (queryTitleAlt && queryTitleAlt.length > 3 && (titleClean.includes(queryTitleAlt) || title.includes(queryTitleAlt))) {
            score += 15;
        } else if (queryWords.length > 0 && queryWords.every(w => title.includes(w) || author.includes(w))) {
            score += 10;
        } else if (queryWords.length > 0 && queryWords.filter(w => title.includes(w) || author.includes(w)).length >= queryWords.length * 0.7) {
            score += 6;
        }

        // ── Artist matching ──
        const effectiveArtist = queryArtist || queryArtistAlt;
        if (effectiveArtist) {
            if (author.includes(effectiveArtist)) score += 12;
            else if (title.includes(effectiveArtist)) score += 5;
        }

        // ── Duration (ideal song length: 1.5-7 minutes) ──
        if (length >= 90000 && length <= 420000) score += 4;
        if (length < 30000) score -= 10;   // clip/preview
        if (length > 600000) score -= 5;   // mix/compilation

        // ── Anti-garbage (aggressive — keeps the ORIGINAL version) ──
        if (!queryLower.includes('remix') && title.includes('remix')) score -= 8;
        if (!queryLower.includes('cover') && title.includes('cover')) score -= 8;
        if (!queryLower.includes('live') && /\blive\b/.test(title)) score -= 4;
        if (title.includes('karaoke')) score -= 15;
        if (title.includes('instrumental') && !queryLower.includes('instrumental')) score -= 10;
        if (title.includes('8d audio') || title.includes('slowed')) score -= 12;
        if (title.includes('nightcore') && !queryLower.includes('nightcore')) score -= 10;
        if (title.includes('bass boosted')) score -= 10;
        if (title.includes('sped up') && !queryLower.includes('sped up')) score -= 8;
        if (title.includes('reverb') && !queryLower.includes('reverb')) score -= 6;
        if (title.includes('lofi') && !queryLower.includes('lofi')) score -= 5;
        if (title.includes('mashup') && !queryLower.includes('mashup')) score -= 6;
        if (title.includes('tutorial') || title.includes('reaction')) score -= 15;
        if (title.includes('parody')) score -= 12;

        // ── Quality / official signals (prefer original uploads) ──
        if (author.includes('- topic')) score += 5;   // YouTube Music auto-generated = high quality original
        if (author.includes('vevo')) score += 4;
        if (author.includes('official')) score += 2;
        if (title.includes('official audio')) score += 3;
        if (title.includes('official music video')) score += 2;

        // ── Position bonus (YouTube ranks best results first) ──
        const index = tracks.indexOf(track);
        if (index === 0) score += 2;
        else if (index === 1) score += 1;

        if (score > bestScore) {
            bestScore = score;
            bestTrack = track;
        }
    }

    return bestTrack;
}

async function waitForNode(shoukaku, timeoutMs = 7000, intervalMs = 350) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const node = shoukaku.options.nodeResolver(shoukaku.nodes);
        if (node) return node;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return null;
}

/**
 * Find yt-dlp executable — checks PATH and project root
 */
let ytdlpPath = null;
function getYtDlpPath() {
    if (ytdlpPath) return ytdlpPath;

    // Check local project first
    const localExe = join(ROOT, 'yt-dlp.exe');
    if (existsSync(localExe)) {
        ytdlpPath = localExe;
        return ytdlpPath;
    }

    // Check PATH
    try {
        const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
        const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
        if (result) {
            ytdlpPath = result.trim();
            return ytdlpPath;
        }
    } catch {}

    return null;
}

/**
 * Auto-install yt-dlp if not found (runs once)
 */
let ytdlpInstallAttempted = false;
async function ensureYtDlp() {
    if (getYtDlpPath()) return true;
    if (ytdlpInstallAttempted) return false;
    ytdlpInstallAttempted = true;

    logger.warn('yt-dlp not found — attempting auto-install...');

    try {
        if (process.platform === 'win32') {
            // Download binary directly into project folder
            execSync(
                'powershell -Command "Invoke-WebRequest -Uri \'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe\' -OutFile \'yt-dlp.exe\'"',
                { cwd: ROOT, timeout: 120000, stdio: 'pipe' }
            );
            if (existsSync(join(ROOT, 'yt-dlp.exe'))) {
                ytdlpPath = join(ROOT, 'yt-dlp.exe');
                logger.info('✓ yt-dlp.exe auto-downloaded');
                return true;
            }
        } else {
            // Linux/Mac — try pip
            execSync('pip3 install yt-dlp 2>/dev/null || pip install yt-dlp', {
                timeout: 120000, stdio: 'pipe',
            });
            ytdlpPath = null; // reset cache
            if (getYtDlpPath()) {
                logger.info('✓ yt-dlp auto-installed via pip');
                return true;
            }
        }
    } catch (e) {
        logger.error(`yt-dlp auto-install failed: ${e.message}`);
    }

    logger.error('Cannot resolve audio: No Lavalink and no yt-dlp available.');
    logger.error('Install yt-dlp manually: pip install yt-dlp  or  winget install yt-dlp');
    return false;
}

/**
 * Build a normalized resolved track object from a Lavalink track
 */
function buildResolved(track) {
    return {
        track: track.encoded,
        info: {
            title: track.info.title,
            author: track.info.author,
            uri: track.info.uri,
            length: track.info.length,
            artworkUrl: track.info.artworkUrl || null,
            sourceName: track.info.sourceName || 'unknown',
            isStream: track.info.isStream || false,
            isrc: track.info.isrc || null,
        },
        _playlist: track._playlist || null,
    };
}

/**
 * Resolve a query to a playable track using Lavalink, with yt-dlp fallback.
 *
 * Smart cascade:
 *  1. URLs → direct Lavalink resolve (YouTube, Spotify, SoundCloud)
 *  2. Text → ytsearch → scsearch → spsearch (if credentials exist)
 *  3. Fallback → yt-dlp binary
 *
 * Handles playlists, albums, singles, shorts, and live streams.
 *
 * @param {import('shoukaku').Shoukaku} shoukaku - Shoukaku instance
 * @param {string} query - URL or search query
 * @returns {Promise<{track: object, info: object, _playlist?: object} | null>}
 */
export async function resolveTrack(shoukaku, query) {
    // Check cache first
    const cached = trackCache.get(query);
    if (cached) return cached;

    const node = await waitForNode(shoukaku);
    if (!node) {
        logger.warn('No Lavalink nodes available — trying yt-dlp fallback');
        return ytdlpFallback(query);
    }

    try {
        const queryType = classifyQuery(query);
        let result = null;

        if (queryType === 'search') {
            // ── Text search: try multiple sources with smart ordering ──
            const cleanQuery = normalizeSearchQuery(query);
            // Request 10 results from YouTube for better scoring accuracy
            const searchSources = ['ytsearch10:'];

            // SoundCloud as secondary
            searchSources.push('scsearch:');

            // Only add Spotify search if credentials are configured
            if (config.spotify.clientId && config.spotify.clientSecret) {
                searchSources.push('spsearch:');
            }

            for (const prefix of searchSources) {
                result = await node.rest.resolve(`${prefix}${cleanQuery}`).catch(() => null);
                if (result && result.loadType !== 'empty' && result.loadType !== 'error') {
                    break;
                }
                result = null;
            }

            // If the normalized query failed, try the original raw query
            if (!result && cleanQuery !== query.trim()) {
                for (const prefix of searchSources) {
                    result = await node.rest.resolve(`${prefix}${query.trim()}`).catch(() => null);
                    if (result && result.loadType !== 'empty' && result.loadType !== 'error') {
                        break;
                    }
                    result = null;
                }
            }
        } else {
            // ── Direct URL: send to Lavalink as-is ──
            result = await node.rest.resolve(query).catch(() => null);

            // Spotify URL without credentials → warn and try to extract searchable text
            if ((!result || result.loadType === 'empty' || result.loadType === 'error')
                && (queryType === 'spotify_track' || queryType === 'spotify_collection')) {
                if (!config.spotify.clientId || !config.spotify.clientSecret) {
                    logger.warn('Spotify URL failed — SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env');
                }
                // Try to extract a title from the Spotify URL slug for YouTube search
                const slug = query.match(/\/(?:track|album|playlist)\/[a-zA-Z0-9]+(?:\?.*)?$/)?.[0];
                if (!slug) {
                    // Can't extract anything useful — fall through to ytdlp
                }
            }

            // YouTube URL failed → try normalizing the URL
            if ((!result || result.loadType === 'empty' || result.loadType === 'error')
                && (queryType === 'youtube_video' || queryType === 'youtube_playlist')) {
                // Strip tracking params and try again
                try {
                    const urlObj = new URL(query);
                    if (queryType === 'youtube_playlist') {
                        const listId = urlObj.searchParams.get('list');
                        if (listId) {
                            const cleanUrl = `https://www.youtube.com/playlist?list=${listId}`;
                            result = await node.rest.resolve(cleanUrl).catch(() => null);
                        }
                    } else {
                        const videoId = query.match(YOUTUBE_VIDEO_RE)?.[1];
                        if (videoId) {
                            const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
                            result = await node.rest.resolve(cleanUrl).catch(() => null);
                        }
                    }
                } catch {}
            }
        }

        // ── No result from Lavalink → yt-dlp fallback ──
        if (!result || result.loadType === 'empty' || result.loadType === 'error') {
            logger.debug(`Lavalink found nothing for "${query}" [type=${queryType}] — trying yt-dlp`);
            return ytdlpFallback(query);
        }

        // ── Process Lavalink result ──
        let track;
        switch (result.loadType) {
            case 'track':
                track = result.data;
                break;
            case 'search':
                track = pickBestSearchResult(result.data, query);
                break;
            case 'playlist': {
                const playlistTracks = result.data.tracks || [];
                if (playlistTracks.length === 0) {
                    return ytdlpFallback(query);
                }
                track = playlistTracks[0];
                if (track) {
                    track._playlist = {
                        name: result.data.info?.name || 'Unknown Playlist',
                        tracks: playlistTracks,
                    };
                }
                break;
            }
            default:
                return ytdlpFallback(query);
        }

        if (!track) return ytdlpFallback(query);

        const resolved = buildResolved(track);
        trackCache.set(query, resolved);
        return resolved;

    } catch (err) {
        logger.error(`Lavalink resolve error for "${query}": ${err.message}`);
        return ytdlpFallback(query);
    }
}

/**
 * Resolve multiple tracks from a playlist URL.
 * Handles YouTube playlists, Spotify playlists/albums, SoundCloud sets.
 * Includes URL normalization and retry logic.
 */
export async function resolvePlaylist(shoukaku, url) {
    const node = await waitForNode(shoukaku);
    if (!node) return [];

    const queryType = classifyQuery(url);

    try {
        // Try the URL directly first
        let result = await node.rest.resolve(url).catch(() => null);

        // If it failed, try normalizing the URL
        if (!result || result.loadType === 'empty' || result.loadType === 'error') {
            if (queryType === 'youtube_playlist') {
                try {
                    const urlObj = new URL(url);
                    const listId = urlObj.searchParams.get('list');
                    if (listId) {
                        const cleanUrl = `https://www.youtube.com/playlist?list=${listId}`;
                        result = await node.rest.resolve(cleanUrl).catch(() => null);
                    }
                } catch {}
            }
        }

        if (result?.loadType === 'playlist' && result.data?.tracks?.length > 0) {
            return result.data.tracks.map(track => buildResolved(track));
        }

        // Single track result (some URLs resolve this way)
        if (result?.loadType === 'track' && result.data) {
            return [buildResolved(result.data)];
        }

        logger.debug(`Playlist resolve returned ${result?.loadType || 'null'} for: ${url}`);
    } catch (err) {
        logger.error(`Playlist resolve error: ${err.message}`);
    }
    return [];
}

/**
 * yt-dlp fallback resolver.
 * Handles both single tracks and playlist URLs.
 * For playlists: returns first track with _playlist metadata.
 */
async function ytdlpFallback(query) {
    const available = await ensureYtDlp();
    if (!available) return null;

    const exe = getYtDlpPath();
    if (!exe) return null;

    const queryType = classifyQuery(query);
    const isPlaylist = queryType === 'youtube_playlist' || queryType === 'soundcloud_set' || queryType === 'spotify_collection';

    return new Promise((resolve) => {
        let args;
        // VPS-friendly base args: bypass geo-restrictions & use reliable clients
        const baseArgs = [
            '--no-check-certificates',
            '--geo-bypass',
            '--extractor-args', 'youtube:player_client=android_music,web',
        ];

        if (isPlaylist && isURL(query)) {
            args = [...baseArgs, '--flat-playlist', '-j', query];
        } else if (isURL(query)) {
            args = [...baseArgs, '-j', '--no-playlist', query];
        } else {
            const cleanQuery = normalizeSearchQuery(query);
            args = [...baseArgs, '-j', '--no-playlist', `ytsearch5:${cleanQuery}`];
        }

        execFile(exe, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                logger.debug(`yt-dlp fallback failed: ${error.message}`);
                resolve(null);
                return;
            }

            try {
                const lines = stdout.trim().split('\n').filter(Boolean);

                if (isPlaylist && lines.length > 1) {
                    // Playlist mode: parse each line as a track
                    const tracks = [];
                    for (const line of lines) {
                        try {
                            const info = JSON.parse(line);
                            const audioUrl = info.url || info.formats?.find(f => f.acodec !== 'none')?.url;
                            tracks.push({
                                track: null,
                                info: {
                                    title: info.title || 'Unknown',
                                    author: info.uploader || info.channel || 'Unknown',
                                    uri: info.webpage_url || info.original_url || audioUrl || '',
                                    length: (info.duration || 0) * 1000,
                                    artworkUrl: info.thumbnail || null,
                                    sourceName: 'yt-dlp',
                                    isStream: info.is_live || false,
                                    directUrl: audioUrl || null,
                                },
                            });
                        } catch {}
                    }
                    if (tracks.length > 0) {
                        const first = tracks[0];
                        first._playlist = {
                            name: `Playlist (${tracks.length} tracks)`,
                            tracks: tracks,
                        };
                        resolve(first);
                        return;
                    }
                }

                // Single track mode (or search with multiple results)
                if (lines.length >= 1) {
                    // If search returned multiple results, pick best
                    if (!isURL(query) && lines.length > 1) {
                        const candidates = lines.map(l => {
                            try { return JSON.parse(l); } catch { return null; }
                        }).filter(Boolean);

                        // Simple scoring: prefer actual songs (right duration, not clips)
                        const scored = candidates.map(info => {
                            let score = 0;
                            const dur = info.duration || 0;
                            if (dur >= 90 && dur <= 420) score += 5;   // 1.5-7 min
                            if (dur < 30) score -= 5;                   // clip
                            if (dur > 600) score -= 3;                  // mix
                            const title = (info.title || '').toLowerCase();
                            if (title.includes('karaoke')) score -= 10;
                            if (title.includes('nightcore')) score -= 5;
                            if (title.includes('8d audio')) score -= 5;
                            if (title.includes('slowed')) score -= 5;
                            return { info, score };
                        });
                        scored.sort((a, b) => b.score - a.score);
                        const best = scored[0]?.info;
                        if (best) {
                            const audioUrl = best.url || best.formats?.find(f => f.acodec !== 'none')?.url;
                            if (audioUrl) {
                                const resolved = {
                                    track: null,
                                    info: {
                                        title: best.title || query,
                                        author: best.uploader || best.channel || 'Unknown',
                                        uri: best.webpage_url || best.original_url || audioUrl,
                                        length: (best.duration || 0) * 1000,
                                        artworkUrl: best.thumbnail || null,
                                        sourceName: 'yt-dlp',
                                        isStream: best.is_live || false,
                                        directUrl: audioUrl,
                                    },
                                    _playlist: null,
                                };
                                trackCache.set(query, resolved, YTDLP_CACHE_TTL);
                                resolve(resolved);
                                return;
                            }
                        }
                    }

                    // Single result
                    const info = JSON.parse(lines[0]);
                    const audioUrl = info.url || info.formats?.find(f => f.acodec !== 'none')?.url;
                    if (!audioUrl) {
                        resolve(null);
                        return;
                    }

                    const resolved = {
                        track: null,
                        info: {
                            title: info.title || query,
                            author: info.uploader || info.channel || 'Unknown',
                            uri: info.webpage_url || info.original_url || audioUrl,
                            length: (info.duration || 0) * 1000,
                            artworkUrl: info.thumbnail || null,
                            sourceName: 'yt-dlp',
                            isStream: info.is_live || false,
                            directUrl: audioUrl,
                        },
                        _playlist: null,
                    };

                    trackCache.set(query, resolved, YTDLP_CACHE_TTL);
                    resolve(resolved);
                } else {
                    resolve(null);
                }
            } catch {
                resolve(null);
            }
        });
    });
}

/**
 * Check if string is a URL
 */
function isURL(str) {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}
