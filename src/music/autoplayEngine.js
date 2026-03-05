import { logger } from '../utils/logger.js';
import { getSmartRecommendations } from '../ai/recommendationAI.js';
import { getTrendingTracks } from '../ai/trendAnalyzer.js';
import { detectTrackMood } from '../ai/moodEngine.js';
import { rankCandidates, buildMoodSummary } from '../ai/similarityEngine.js';

/**
 * ═══════════════════════════════════════════════════════════════
 *  Autoplay Engine v4 — Spotify/YouTube Song Radio
 * ═══════════════════════════════════════════════════════════════
 *
 * How Spotify's autoplay actually works (research-based):
 *
 *  SPOTIFY "Song Radio" / Autoplay:
 *  1. SEED TRACK — The currently playing song IS the seed. Every
 *     recommendation radiates outward from this exact song.
 *  2. AUDIO DNA — Spotify matches songs by acoustic features:
 *     tempo, energy, valence (happy/sad), danceability, key,
 *     acousticness, instrumentalness. We approximate this via AI.
 *  3. ARTIST GRAPH — Spotify maps artists on a similarity graph.
 *     "Fans who listen to Artist A also listen to Artist B."
 *     We replicate this by searching "Artist radio" on YouTube.
 *  4. SAME LANGUAGE/REGION — Spotify strongly clusters by language.
 *     If you play a Hindi song, radio stays Hindi. Always.
 *  5. EDITORIAL TASTE VECTORS — Every song has a taste profile
 *     vector. Radio picks songs with nearest vectors.
 *  6. NATURAL FLOW — Each song transitions smoothly in energy,
 *     tempo, and mood. No jarring genre jumps.
 *
 *  YOUTUBE "Up Next":
 *  1. Uses the current video as seed
 *  2. Matches by topic/genre tags on the video
 *  3. Heavily weights same-channel and same-artist content
 *  4. Factors in co-watch patterns (users who watched A also B)
 *  5. Keeps same language/region
 *
 *  OUR IMPLEMENTATION:
 *  Priority 1: AI (if available) — full Spotify-grade analysis
 *              with seed track DNA, artist graph, mood matching
 *  Priority 2: YouTube seed search — "Artist - Title" radio queries
 *              that trigger YouTube's own recommendation engine
 *  Priority 3: Spotify search — spsearch: queries leverage
 *              Spotify's own algorithm via Lavalink
 *  Priority 4: Local algorithm — genre/language/artist fallback
 *  Priority 5: Trending — genre-filtered popular tracks
 *
 *  SoundCloud is NOT used for autoplay discovery. It lacks the
 *  recommendation intelligence of YouTube/Spotify and returns
 *  low-quality matches (remixes, covers, amateur uploads).
 */

// ── Per-guild autoplay state ────────────────────────────────────
const autoplayBuffers = new Map();

const BUFFER_LOW_THRESHOLD = 2;
const BUFFER_TARGET_SIZE = 6;

/**
 * Clean artist name from YouTube noise (e.g. "ArijitSinghVEVO" → "Arijit Singh")
 */
function cleanArtistName(artist) {
    if (!artist) return '';
    let a = artist;
    // Strip VEVO, - Topic, Official, Records suffixes
    a = a.replace(/\s*[-–]\s*Topic$/i, '');
    a = a.replace(/VEVO$/i, '');
    a = a.replace(/\s*Official$/i, '');
    a = a.replace(/\s*Music$/i, '');
    a = a.replace(/\s*Records$/i, '');
    return a.trim() || artist;
}

/**
 * Clean track title from YouTube metadata noise
 */
function cleanTrackTitle(title, artist) {
    if (!title) return '';
    let t = title;
    // Remove common YouTube suffixes/noise
    t = t.replace(/\s*\(Official\s*(Music\s*)?Video\)/gi, '');
    t = t.replace(/\s*\(Official\s*Audio\)/gi, '');
    t = t.replace(/\s*\(Lyric\s*Video\)/gi, '');
    t = t.replace(/\s*\(Lyrics?\)/gi, '');
    t = t.replace(/\s*\(Visuali[sz]er\)/gi, '');
    t = t.replace(/\s*\[Official\s*(Music\s*)?Video\]/gi, '');
    t = t.replace(/\s*\[Official\s*Audio\]/gi, '');
    t = t.replace(/\s*\[Lyrics?\]/gi, '');
    t = t.replace(/\s*\|\s*Official\s*(Music\s*)?Video/gi, '');
    t = t.replace(/\s*-\s*Official\s*(Music\s*)?Video/gi, '');
    // Remove artist prefix from title if it's duplicated (e.g. "Artist - Artist Song")
    if (artist) {
        const re = new RegExp(`^${artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—:]\\s*`, 'i');
        t = t.replace(re, '');
    }
    return t.trim() || title;
}

// ── Language detection patterns ─────────────────────────────────
const LANGUAGE_PATTERNS = [
    // South Asian
    { lang: 'hindi', re: /[\u0900-\u097F]|bollywood|hindi|desi\b/i },
    { lang: 'tamil', re: /[\u0B80-\u0BFF]|tamil|kollywood/i },
    { lang: 'telugu', re: /[\u0C00-\u0C7F]|telugu|tollywood/i },
    { lang: 'punjabi', re: /[\u0A00-\u0A7F]|punjabi/i },
    { lang: 'bengali', re: /[\u0980-\u09FF]|bengali|bangla/i },
    { lang: 'malayalam', re: /[\u0D00-\u0D7F]|malayalam|mollywood/i },
    { lang: 'kannada', re: /[\u0C80-\u0CFF]|kannada|sandalwood/i },
    { lang: 'marathi', re: /marathi/i },
    { lang: 'gujarati', re: /[\u0A80-\u0AFF]|gujarati/i },
    // East Asian
    { lang: 'korean', re: /[\uAC00-\uD7AF]|k-?pop|korean|\bBTS\b|\bBLACKPINK\b/i },
    { lang: 'japanese', re: /[\u3040-\u30FF]|j-?pop|japanese|anime|vocaloid/i },
    { lang: 'chinese', re: /[\u4E00-\u9FFF]|mandopop|cantopop|chinese|c-?pop/i },
    // Latin/European
    { lang: 'spanish', re: /reggaet[oó]n|latin\b|spanish|español|bachata|salsa|corrido|cumbia|\bBad Bunny\b|\bOzuna\b|\bDaddy Yankee\b/i },
    { lang: 'portuguese', re: /portuguese|brasileiro|funk\s*carioca|sertanejo|mpb/i },
    { lang: 'french', re: /french|français/i },
    { lang: 'italian', re: /italian|italiano/i },
    { lang: 'german', re: /german|deutsch|schlager/i },
    // Middle Eastern / African
    { lang: 'arabic', re: /[\u0600-\u06FF]|arabic|maghreb/i },
    { lang: 'turkish', re: /[\u011E\u011F\u015E\u015F\u0130\u0131]|turkish|türkçe|arabesk/i },
    { lang: 'russian', re: /[\u0400-\u04FF]|russian|русский/i },
    { lang: 'afrobeats', re: /afrobeats|afro\s*pop|naija|amapiano/i },
];

// ── Artist → genre/scene mapping for common artists ─────────────
// This acts as a quick lookup to determine the scene when metadata is sparse
const ARTIST_SCENE_MAP = new Map([
    // These patterns match parts of artist names
    ['arijit singh', { lang: 'hindi', genre: 'bollywood' }],
    ['atif aslam', { lang: 'hindi', genre: 'bollywood' }],
    ['shreya ghoshal', { lang: 'hindi', genre: 'bollywood' }],
    ['a.r. rahman', { lang: 'hindi', genre: 'bollywood' }],
    ['pritam', { lang: 'hindi', genre: 'bollywood' }],
    ['neha kakkar', { lang: 'hindi', genre: 'bollywood' }],
    ['badshah', { lang: 'hindi', genre: 'punjabi pop' }],
    ['diljit dosanjh', { lang: 'punjabi', genre: 'punjabi pop' }],
    ['ap dhillon', { lang: 'punjabi', genre: 'punjabi pop' }],
    ['sidhu moose wala', { lang: 'punjabi', genre: 'punjabi hip hop' }],
    ['anirudh', { lang: 'tamil', genre: 'kollywood' }],
    ['bts', { lang: 'korean', genre: 'k-pop' }],
    ['blackpink', { lang: 'korean', genre: 'k-pop' }],
    ['stray kids', { lang: 'korean', genre: 'k-pop' }],
    ['twice', { lang: 'korean', genre: 'k-pop' }],
    ['bad bunny', { lang: 'spanish', genre: 'reggaeton' }],
    ['ozuna', { lang: 'spanish', genre: 'reggaeton' }],
    ['j balvin', { lang: 'spanish', genre: 'reggaeton' }],
    ['rosalía', { lang: 'spanish', genre: 'latin pop' }],
    ['burna boy', { lang: 'afrobeats', genre: 'afrobeats' }],
    ['wizkid', { lang: 'afrobeats', genre: 'afrobeats' }],
    ['davido', { lang: 'afrobeats', genre: 'afrobeats' }],
]);

/**
 * Detect language/region from track — checks metadata + artist database
 */
function detectLanguage(track) {
    if (!track?.info) return null;
    const text = `${track.info.title || ''} ${track.info.author || ''}`;

    // Check artist scene map first (handles English-titled songs by regional artists)
    const authorLower = (track.info.author || '').toLowerCase();
    for (const [artist, scene] of ARTIST_SCENE_MAP) {
        if (authorLower.includes(artist)) return scene.lang;
    }

    // Then check text patterns
    for (const { lang, re } of LANGUAGE_PATTERNS) {
        if (re.test(text)) return lang;
    }
    return null;
}

/**
 * Detect genre from track — checks artist map + metadata keywords
 */
function detectGenreFromTrack(track) {
    if (!track?.info) return null;
    const authorLower = (track.info.author || '').toLowerCase();
    for (const [artist, scene] of ARTIST_SCENE_MAP) {
        if (authorLower.includes(artist)) return scene.genre;
    }
    return null;
}

/**
 * Detect genres across multiple tracks
 */
function detectGenres(tracks) {
    const genreTerms = [
        'pop', 'rock', 'hip hop', 'rap', 'r&b', 'rnb', 'jazz', 'blues',
        'country', 'electronic', 'edm', 'house', 'techno', 'trance',
        'dubstep', 'drum and bass', 'dnb', 'ambient', 'lo-fi', 'lofi',
        'indie', 'alternative', 'punk', 'metal', 'classical', 'soul',
        'funk', 'reggae', 'latin', 'k-pop', 'kpop', 'j-pop', 'anime',
        'phonk', 'trap', 'drill', 'gospel', 'folk', 'acoustic',
        'bedroom pop', 'synthwave', 'retrowave', 'vaporwave', 'grunge',
        'emo', 'midwest emo', 'shoegaze', 'dream pop', 'post-punk',
        'neo soul', 'afrobeats', 'dancehall', 'bossa nova',
        'bollywood', 'desi', 'punjabi', 'reggaeton', 'cumbia',
        'amapiano', 'corrido', 'pluggnb',
    ];
    const found = new Map();

    // First check artist scene map for each track
    for (const t of tracks) {
        const mapped = detectGenreFromTrack(t);
        if (mapped) found.set(mapped, (found.get(mapped) || 0) + 3); // heavy weight
    }

    // Then scan text
    for (const t of tracks) {
        const text = `${t.info.title} ${t.info.author}`.toLowerCase();
        for (const term of genreTerms) {
            if (text.includes(term)) {
                found.set(term, (found.get(term) || 0) + 1);
            }
        }
    }
    return [...found.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([term]) => term);
}

/**
 * Get or create the autoplay buffer for a guild
 */
function getBuffer(guildId) {
    if (!autoplayBuffers.has(guildId)) {
        autoplayBuffers.set(guildId, {
            tracks: [],
            refilling: false,
            lastRefill: 0,
            failCount: 0,
            detectedLanguage: null,
            detectedGenres: [],
        });
    }
    return autoplayBuffers.get(guildId);
}

/**
 * Clear autoplay buffer (call when user manually queues or stops)
 */
export function clearAutoplayBuffer(guildId) {
    autoplayBuffers.delete(guildId);
}

/**
 * Main entry point — get the next autoplay track.
 * Returns immediately from buffer if available, otherwise fetches fresh.
 */
export async function getAutoplayTrack(shoukaku, queue) {
    const guildId = queue.guildId;
    const buffer = getBuffer(guildId);

    // 1. Return from buffer if available
    if (buffer.tracks.length > 0) {
        const track = buffer.tracks.shift();
        logger.debug(`Autoplay buffer hit for ${guildId} (${buffer.tracks.length} remaining)`);

        // Background refill when running low
        if (buffer.tracks.length <= BUFFER_LOW_THRESHOLD && !buffer.refilling) {
            refillBuffer(shoukaku, queue).catch(() => {});
        }
        return track;
    }

    // 2. Buffer empty — synchronous fill
    logger.debug(`Autoplay buffer empty for ${guildId} — filling...`);
    await refillBuffer(shoukaku, queue);

    if (buffer.tracks.length > 0) {
        return buffer.tracks.shift();
    }

    // 3. All strategies failed
    if (!buffer._lastExhaustedLog || Date.now() - buffer._lastExhaustedLog > 300000) {
        logger.warn(`Autoplay: all strategies exhausted for ${guildId}`);
        buffer._lastExhaustedLog = Date.now();
    }
    return null;
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  BUFFER REFILL — The Spotify/YouTube autoplay pipeline
 * ═══════════════════════════════════════════════════════════════
 *
 * This is the heart of autoplay. The strategy cascade:
 *
 * 1. AI FIRST (if available) — Gets the best results because it
 *    understands the full context: genre, language, mood, energy,
 *    artist relationships, and the exact song playing. This is
 *    what makes Spotify's radio sound perfect.
 *
 * 2. YOUTUBE SEED — Uses the current song as seed to search
 *    YouTube. YouTube's own algorithm surfaces related content
 *    when you search "Artist - Song Title radio/mix". This is
 *    how YouTube's "Up Next" works.
 *
 * 3. SPOTIFY SEARCH — Uses spsearch: prefix to leverage Spotify's
 *    discovery algorithm through Lavalink. Good for genre matching.
 *
 * 4. LOCAL ALGORITHM — Builds queries from genre + language +
 *    artist patterns. Fallback when AI and platform algos fail.
 *
 * 5. TRENDING — Last resort, genre-filtered popular tracks.
 */
async function refillBuffer(shoukaku, queue) {
    const guildId = queue.guildId;
    const buffer = getBuffer(guildId);

    if (buffer.refilling) return;
    buffer.refilling = true;

    try {
        const needed = BUFFER_TARGET_SIZE - buffer.tracks.length;
        if (needed <= 0) return;

        const history = queue.history || [];
        const currentTrack = queue.currentTrack;
        const playedSet = buildPlayedSet(history, currentTrack, buffer.tracks);

        // ── Build session fingerprint ──
        const allTracks = [];
        if (currentTrack?.info) allTracks.push(currentTrack);
        for (const t of history.slice(0, 10)) {
            if (t?.info) allTracks.push(t);
        }

        const lang = detectLanguage(currentTrack) || buffer.detectedLanguage;
        const genres = detectGenres(allTracks);
        buffer.detectedLanguage = lang;
        buffer.detectedGenres = genres;

        const sessionCtx = { lang, genres, currentTrack, history: allTracks };

        // ── Mood-aware: detect current track's mood for re-ranking ──
        const seedMood = detectTrackMood(currentTrack, genres[0] || null);
        if (seedMood) {
            logger.debug(`Autoplay seed mood: ${buildMoodSummary(currentTrack, genres[0])}`);
        }

        // ── Strategy 1: AI-powered (Spotify-grade, best quality) ──
        //    AI goes FIRST because it produces the highest quality
        //    recommendations when available. Spotify's entire radio
        //    is AI-driven — we mirror that priority.
        const aiQueries = await getSmartRecommendations(history, currentTrack, needed + 6);
        if (aiQueries.length > 0) {
            let resolved = await resolveOnYouTubeAndSpotify(shoukaku, aiQueries, playedSet, needed + 4);
            // Re-rank resolved tracks by mood similarity to seed
            if (resolved.length > 1 && currentTrack?.info) {
                resolved = rankCandidates(currentTrack, resolved, genres[0] || null, {
                    filterJarring: true,
                    maxResults: needed,
                });
            }
            for (const track of resolved.slice(0, needed)) {
                buffer.tracks.push(track);
                addToPlayedSet(playedSet, track);
            }
            if (resolved.length > 0) {
                logger.info(`Autoplay AI → ${Math.min(resolved.length, needed)} tracks for ${guildId}${lang ? ` [${lang}]` : ''}`);
            }
        }

        // ── Strategy 2: YouTube seed (like YouTube "Up Next") ──
        if (buffer.tracks.length < needed) {
            const remaining = needed - buffer.tracks.length;
            const ytQueries = buildSeedQueries(sessionCtx);
            if (ytQueries.length > 0) {
                let resolved = await resolveOnYouTubeAndSpotify(shoukaku, ytQueries, playedSet, remaining + 3);
                if (resolved.length > 1 && currentTrack?.info) {
                    resolved = rankCandidates(currentTrack, resolved, genres[0] || null, {
                        filterJarring: true,
                        maxResults: remaining,
                    });
                }
                for (const track of resolved.slice(0, remaining)) {
                    buffer.tracks.push(track);
                    addToPlayedSet(playedSet, track);
                }
                if (resolved.length > 0) {
                    logger.info(`Autoplay seed → ${Math.min(resolved.length, remaining)} tracks for ${guildId}`);
                }
            }
        }

        // ── Strategy 3: Spotify discovery search ──
        if (buffer.tracks.length < needed) {
            const remaining = needed - buffer.tracks.length;
            const spQueries = buildSpotifyDiscoveryQueries(sessionCtx);
            if (spQueries.length > 0) {
                let resolved = await resolveSpotifyFirst(shoukaku, spQueries, playedSet, remaining + 3);
                if (resolved.length > 1 && currentTrack?.info) {
                    resolved = rankCandidates(currentTrack, resolved, genres[0] || null, {
                        filterJarring: true,
                        maxResults: remaining,
                    });
                }
                for (const track of resolved.slice(0, remaining)) {
                    buffer.tracks.push(track);
                    addToPlayedSet(playedSet, track);
                }
                if (resolved.length > 0) {
                    logger.info(`Autoplay Spotify → ${Math.min(resolved.length, remaining)} tracks for ${guildId}`);
                }
            }
        }

        // ── Strategy 4: Local algorithm fallback ──
        if (buffer.tracks.length < needed) {
            const remaining = needed - buffer.tracks.length;
            const localQueries = buildLocalFallbackQueries(sessionCtx, remaining + 4);
            const resolved = await resolveOnYouTubeAndSpotify(shoukaku, localQueries, playedSet, remaining);
            for (const track of resolved) {
                buffer.tracks.push(track);
                addToPlayedSet(playedSet, track);
            }
            if (resolved.length > 0) {
                logger.info(`Autoplay local → ${resolved.length} tracks for ${guildId}`);
            }
        }

        // ── Strategy 5: Trending fallback ──
        if (buffer.tracks.length < 1) {
            const trending = await getTrendingTracks();
            if (trending.length > 0) {
                const shuffled = [...trending].sort(() => Math.random() - 0.5);
                const trendQueries = shuffled.slice(0, 6).map(t => t.query);
                const resolved = await resolveOnYouTubeAndSpotify(shoukaku, trendQueries, playedSet, 3);
                for (const track of resolved) {
                    buffer.tracks.push(track);
                }
                if (resolved.length > 0) {
                    logger.info(`Autoplay trending → ${resolved.length} tracks for ${guildId}`);
                }
            }
        }

        buffer.failCount = buffer.tracks.length > 0 ? 0 : buffer.failCount + 1;
        buffer.lastRefill = Date.now();

    } catch (err) {
        logger.error(`Autoplay refill error for ${guildId}: ${err.message}`);
        buffer.failCount++;
    } finally {
        buffer.refilling = false;
    }
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  SEED QUERY BUILDER — YouTube "Up Next" style
 *
 *  The key insight from YouTube's algorithm: the CURRENT SONG
 *  is the seed. All queries radiate from it. YouTube surfaces
 *  related content based on:
 *  - Same artist's other songs
 *  - Songs co-watched with this one
 *  - Same topic/genre tags
 *  - Same language
 *
 *  We generate queries that trigger YouTube's internal "related"
 *  engine — searching "Artist - Title" activates their matching.
 * ═══════════════════════════════════════════════════════════════
 */
function buildSeedQueries({ currentTrack, history, lang, genres }) {
    const queries = [];
    const used = new Set();

    function add(q) {
        const key = q.toLowerCase().trim();
        if (key.length > 3 && !used.has(key)) {
            used.add(key);
            queries.push(q);
        }
    }

    if (!currentTrack?.info) return queries;

    const artist = cleanArtistName(currentTrack.info.author?.trim() || '');
    const title = cleanTrackTitle(currentTrack.info.title?.trim() || '', artist);
    const genre = genres[0] || '';

    // ── Most effective: exact "Artist - Title" triggers YouTube related ──
    add(`${artist} - ${title}`);
    add(`${artist} ${title}`);

    // ── Seed radio / mix — triggers YouTube's recommendation engine ──
    add(`${artist} ${title} radio`);
    add(`${artist} mix`);
    add(`${artist} best songs`);
    add(`${artist} popular songs`);
    add(`songs like ${title} by ${artist}`);
    add(`${artist} playlist`);

    // ── Language-scoped discovery ──
    if (lang) {
        add(`${lang} songs like ${title}`);
        add(`${lang} ${genre || 'songs'} mix`);
        add(`best ${lang} songs`);
        add(`new ${lang} songs`);
        add(`${lang} hits`);
    }

    // ── Genre-scoped ──
    if (genre) {
        add(`${genre} songs like ${title}`);
        add(`best ${genre} songs`);
        add(`${genre} playlist`);
    }

    // ── Co-listened artists (YouTube co-watch pattern) ──
    const seenArtists = new Set([artist.toLowerCase()]);
    for (const t of (history || []).slice(0, 6)) {
        const a = cleanArtistName(t?.info?.author?.trim() || '');
        if (a && !seenArtists.has(a.toLowerCase())) {
            seenArtists.add(a.toLowerCase());
            add(`${a} best songs`);
            add(`${a} - ${cleanTrackTitle(t?.info?.title || '', a)}`);
        }
    }

    return queries;
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  SPOTIFY DISCOVERY QUERIES
 *
 *  Spotify's search algorithm has strong genre/mood understanding.
 *  When we use spsearch:, Lavalink queries Spotify's API which
 *  returns results influenced by Spotify's own recommendation
 *  engine. These queries are designed to leverage that.
 * ═══════════════════════════════════════════════════════════════
 */
function buildSpotifyDiscoveryQueries({ currentTrack, lang, genres }) {
    const queries = [];
    const used = new Set();

    function add(q) {
        const key = q.toLowerCase().trim();
        if (key.length > 3 && !used.has(key)) {
            used.add(key);
            queries.push(q);
        }
    }

    if (!currentTrack?.info) return queries;

    const artist = currentTrack.info.author?.trim() || '';
    const title = currentTrack.info.title?.trim() || '';
    const genre = genres[0] || '';

    // Spotify search is excellent at "Artist - Song" → related songs
    add(`${artist} - ${title}`);
    add(`${artist}`);

    // Spotify understands genre queries well
    if (genre) {
        add(`${genre} ${lang || ''}`.trim());
    }
    if (lang) {
        add(`${lang} music`);
    }

    return queries;
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  LOCAL FALLBACK — No AI, no platform algos
 *
 *  When AI is unavailable and platform searches return garbage,
 *  this builds the best possible queries from raw metadata.
 *  Heavily weighted toward the current track's characteristics.
 * ═══════════════════════════════════════════════════════════════
 */
function buildLocalFallbackQueries({ currentTrack, history, lang, genres }, count) {
    const queries = [];
    const used = new Set();

    function add(q) {
        const key = q.toLowerCase().trim();
        if (key.length > 3 && !used.has(key)) {
            used.add(key);
            queries.push(q);
        }
    }

    if (currentTrack?.info) {
        const a = cleanArtistName(currentTrack.info.author?.trim() || '');
        const t = cleanTrackTitle(currentTrack.info.title?.trim() || '', a);

        add(`${a} - ${t}`);
        add(`${a} songs`);
        add(`${a} best songs`);
        add(`${a} latest`);
        add(`songs similar to ${t}`);
        add(`more songs like ${a}`);

        if (lang) {
            add(`${a} ${lang}`);
            add(`new ${lang} songs`);
            add(`trending ${lang} music`);
            add(`${lang} hits playlist`);
            add(`best ${lang} songs 2025`);
        }

        if (genres[0]) {
            add(`${genres[0]} songs`);
            add(`best ${genres[0]} songs`);
            if (lang) add(`${lang} ${genres[0]}`);
        }

        if (genres[1]) {
            add(`${genres[1]} playlist`);
        }
    }

    // Related artists from history
    const seenArtists = new Set();
    if (currentTrack?.info?.author) seenArtists.add(currentTrack.info.author.toLowerCase());

    for (const t of (history || []).slice(0, 6)) {
        const a = cleanArtistName(t?.info?.author?.trim() || '');
        if (a && !seenArtists.has(a.toLowerCase())) {
            seenArtists.add(a.toLowerCase());
            add(`${a} best songs`);
            add(`${a} popular songs`);
        }
    }

    // Shuffle for variety
    return queries.sort(() => Math.random() - 0.5).slice(0, count);
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  RESOLVER — YouTube + Spotify ONLY (no SoundCloud)
 *
 *  YouTube first (widest catalog, best for all languages),
 *  then Spotify (best genre/mood matching for discovery).
 *  SoundCloud is excluded — it pollutes autoplay with remixes,
 *  covers, and low-quality amateur uploads.
 * ═══════════════════════════════════════════════════════════════
 */
async function resolveOnYouTubeAndSpotify(shoukaku, queries, playedSet, maxTracks) {
    const resolved = [];
    const node = shoukaku.options.nodeResolver(shoukaku.nodes);
    if (!node) return resolved;

    for (const query of queries) {
        if (resolved.length >= maxTracks) break;

        try {
            let track = null;

            // YouTube first — widest catalog, all languages
            const ytResult = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
            if (ytResult?.loadType === 'search' && ytResult.data?.length > 0) {
                track = findBestMatch(ytResult.data, query);
            }

            // Spotify second — strong genre/mood matching
            if (!track?.encoded) {
                const spResult = await node.rest.resolve(`spsearch:${query}`).catch(() => null);
                if (spResult?.loadType === 'search' && spResult.data?.length > 0) {
                    track = findBestMatch(spResult.data, query);
                }
            }

            // No SoundCloud — it degrades autoplay quality

            if (track?.encoded && track?.info) {
                const titleLower = track.info.title?.toLowerCase() || '';
                const uri = track.info.uri || '';

                // Dedup by title and URI
                if (playedSet.has(titleLower) || playedSet.has(uri)) {
                    continue;
                }

                // Extra dedup: fuzzy title match (catches "Song Title (Official Video)" vs "Song Title")
                const titleClean = titleLower.replace(/\(.*?\)|\[.*?\]/g, '').trim();
                let isDup = false;
                for (const played of playedSet) {
                    if (typeof played === 'string' && !played.startsWith('http')) {
                        const playedClean = played.replace(/\(.*?\)|\[.*?\]/g, '').trim();
                        if (playedClean.length > 10 && titleClean.length > 10 &&
                            (titleClean.includes(playedClean) || playedClean.includes(titleClean))) {
                            isDup = true;
                            break;
                        }
                    }
                }
                if (isDup) continue;

                const source = track.info.sourceName?.toLowerCase() || 'unknown';
                resolved.push({
                    track: track.encoded,
                    info: {
                        title: track.info.title || query,
                        author: track.info.author || 'Unknown',
                        uri: track.info.uri || '',
                        length: track.info.length || 0,
                        artworkUrl: track.info.artworkUrl || null,
                        sourceName: source,
                        isStream: track.info.isStream || false,
                    },
                });
            }
        } catch (err) {
            logger.debug(`Autoplay resolve failed for "${query}": ${err.message}`);
        }
    }

    return resolved;
}

/**
 * Spotify-first resolver for discovery queries
 */
async function resolveSpotifyFirst(shoukaku, queries, playedSet, maxTracks) {
    const resolved = [];
    const node = shoukaku.options.nodeResolver(shoukaku.nodes);
    if (!node) return resolved;

    for (const query of queries) {
        if (resolved.length >= maxTracks) break;

        try {
            let track = null;

            // Spotify first for discovery queries
            const spResult = await node.rest.resolve(`spsearch:${query}`).catch(() => null);
            if (spResult?.loadType === 'search' && spResult.data?.length > 0) {
                // Pick from top 5 results randomly for variety (Spotify radio does this)
                const candidates = spResult.data.slice(0, 5);
                const shuffled = candidates.sort(() => Math.random() - 0.5);
                track = findBestMatch(shuffled, query);
            }

            // YouTube fallback
            if (!track?.encoded) {
                const ytResult = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
                if (ytResult?.loadType === 'search' && ytResult.data?.length > 0) {
                    track = findBestMatch(ytResult.data, query);
                }
            }

            if (track?.encoded && track?.info) {
                const titleLower = track.info.title?.toLowerCase() || '';
                const uri = track.info.uri || '';
                if (playedSet.has(titleLower) || playedSet.has(uri)) continue;

                const source = track.info.sourceName?.toLowerCase() || 'unknown';
                resolved.push({
                    track: track.encoded,
                    info: {
                        title: track.info.title || query,
                        author: track.info.author || 'Unknown',
                        uri: track.info.uri || '',
                        length: track.info.length || 0,
                        artworkUrl: track.info.artworkUrl || null,
                        sourceName: source,
                        isStream: track.info.isStream || false,
                    },
                });
            }
        } catch (err) {
            logger.debug(`Autoplay Spotify resolve failed for "${query}": ${err.message}`);
        }
    }

    return resolved;
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  BEST-MATCH SCORING
 *  Picks the right version of a song from search results.
 *  Penalizes garbage (karaoke, nightcore, bass boosted),
 *  rewards official sources and correct duration.
 * ═══════════════════════════════════════════════════════════════
 */
function findBestMatch(tracks, query) {
    if (!tracks || tracks.length === 0) return null;

    const queryLower = query.toLowerCase();
    const parts = queryLower.split(/\s*[-–—]\s*/);
    const queryArtist = parts[0]?.trim() || '';
    const queryTitle = parts.slice(1).join(' ').trim() || queryLower;

    let bestScore = -999;
    let bestTrack = tracks[0];

    for (const track of tracks.slice(0, 10)) {
        let score = 0;
        const title = (track.info?.title || '').toLowerCase();
        const author = (track.info?.author || '').toLowerCase();

        // ── Match signals ──
        if (queryTitle && title.includes(queryTitle)) score += 12;
        if (queryArtist && author.includes(queryArtist)) score += 10;
        if (queryArtist && title.includes(queryArtist)) score += 4;
        if (queryTitle && author.includes(queryTitle)) score += 2;
        if (title.includes(queryArtist) && title.includes(queryTitle)) score += 6;

        // ── Quality signals ──
        const length = track.info?.length || 0;
        if (length >= 90000 && length <= 480000) score += 4;
        if (length >= 60000 && length < 90000) score += 2;
        if (length < 30000) score -= 8;
        if (length > 600000) score -= 3;

        // ── Anti-garbage (aggressive) ──
        if (!queryLower.includes('remix') && title.includes('remix')) score -= 5;
        if (!queryLower.includes('cover') && title.includes('cover')) score -= 5;
        if (!queryLower.includes('live') && /\blive\b/.test(title)) score -= 3;
        if (title.includes('karaoke')) score -= 15;
        if (title.includes('instrumental') && !queryLower.includes('instrumental')) score -= 8;
        if (title.includes('8d audio') || title.includes('slowed')) score -= 10;
        if (title.includes('nightcore')) score -= 8;
        if (title.includes('bass boosted')) score -= 8;
        if (title.includes('sped up') && !queryLower.includes('sped up')) score -= 7;
        if (title.includes('reverb') && !queryLower.includes('reverb')) score -= 5;
        if (title.includes('lofi') && !queryLower.includes('lofi')) score -= 4;

        // ── Prefer official/high-quality ──
        if (author.includes('- topic')) score += 3;
        if (author.includes('vevo')) score += 3;
        if (author.includes('official')) score += 2;
        if (title.includes('official audio')) score += 2;
        if (title.includes('official music video')) score += 1;

        if (score > bestScore) {
            bestScore = score;
            bestTrack = track;
        }
    }

    return bestTrack;
}

/**
 * Build dedup set from played history + buffer
 */
function buildPlayedSet(history, currentTrack, bufferTracks) {
    const set = new Set();
    const allTracks = [...history];
    if (currentTrack) allTracks.push(currentTrack);
    for (const t of bufferTracks) allTracks.push(t);

    for (const t of allTracks) {
        if (t?.info?.title) set.add(t.info.title.toLowerCase());
        if (t?.info?.uri) set.add(t.info.uri);
    }
    return set;
}

function addToPlayedSet(set, track) {
    if (track?.info?.title) set.add(track.info.title.toLowerCase());
    if (track?.info?.uri) set.add(track.info.uri);
}
