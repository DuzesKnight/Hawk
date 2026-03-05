/**
 * ═══════════════════════════════════════════════════════════════════
 *  Mood Engine — NLP-based audio feature estimation from metadata
 * ═══════════════════════════════════════════════════════════════════
 *
 * Spotify analyzes each track across measurable audio dimensions:
 *   energy      — intensity / loudness     (0.0 – 1.0)
 *   valence     — happiness vs sadness     (0.0 – 1.0)
 *   danceability — rhythm suitability      (0.0 – 1.0)
 *   tempo       — slow / medium / fast
 *   mood        — categorical label
 *   context     — night / workout / party / chill / driving / focus
 *
 * Since we don't have access to Spotify's audio analysis API,
 * we approximate these features using NLP on:
 *   1. Song title keywords
 *   2. Artist name (scene knowledge)
 *   3. Genre metadata from the autoplay engine
 *
 * This is the same approach described in the user's architecture:
 *   detectMood(song_title) → { mood, energy, valence, tempo, ... }
 */

// ═══════════════════════════════════════════════════════════════════
//  KEYWORD → MOOD MAPPING
//
//  Each keyword contributes votes toward moods + numeric features.
//  Words can appear in song titles, and we use weighted voting
//  so multiple signals reinforce each other.
// ═══════════════════════════════════════════════════════════════════

const MOOD_KEYWORDS = [
    // Sad / Melancholic
    { words: ['sad', 'broken', 'lonely', 'cry', 'tears', 'pain', 'hurt', 'heartbreak', 'miss you', 'alone', 'goodbye', 'lost', 'empty', 'gone', 'without you', 'dying', 'fading', 'sorrow', 'regret', 'ghost', 'haunted', 'falling apart', 'shattered', 'ruined', 'dil', 'tanha', 'judai', 'alvida', 'bewafa', 'ranjha', 'dard'],
      mood: 'sad', energy: 0.2, valence: 0.1, danceability: 0.15, tempo: 'slow', context: 'night' },

    // Romantic / Love
    { words: ['love', 'heart', 'romance', 'kiss', 'forever', 'baby', 'darling', 'together', 'yours', 'mine', 'beautiful', 'soulmate', 'crush', 'desire', 'passion', 'beloved', 'sweetheart', 'ishq', 'pyaar', 'mohabbat', 'tere', 'tera', 'sanam', 'janam', 'dil', 'humsafar', 'saathi'],
      mood: 'romantic', energy: 0.35, valence: 0.55, danceability: 0.3, tempo: 'slow', context: 'night' },

    // Chill / Relaxed
    { words: ['chill', 'relax', 'calm', 'peace', 'serenity', 'breeze', 'sunset', 'sunrise', 'vibes', 'mellow', 'soothing', 'gentle', 'tranquil', 'lazy', 'float', 'drift', 'dream', 'cloud', 'ocean', 'rain', 'lofi', 'lo-fi', 'ambient', 'sleep', 'night', 'moonlight', 'starlight'],
      mood: 'chill', energy: 0.25, valence: 0.4, danceability: 0.25, tempo: 'slow', context: 'relaxing' },

    // Happy / Uplifting
    { words: ['happy', 'joy', 'smile', 'sunshine', 'bright', 'celebrate', 'wonderful', 'amazing', 'perfect', 'good', 'alive', 'free', 'flying', 'golden', 'shining', 'blessed', 'thankful', 'beautiful day', 'feel good', 'uforia', 'euphoria', 'bliss'],
      mood: 'happy', energy: 0.6, valence: 0.85, danceability: 0.6, tempo: 'medium', context: 'driving' },

    // Energetic / Party / Hype
    { words: ['party', 'dance', 'club', 'turn up', 'lit', 'fire', 'hype', 'bass', 'drop', 'bounce', 'groove', 'move', 'shake', 'jump', 'rave', 'festival', 'bang', 'banger', 'wild', 'crazy', 'let go', 'tonight', 'all night', 'dj', 'remix', 'beat', 'pump', 'energy'],
      mood: 'energetic', energy: 0.9, valence: 0.8, danceability: 0.9, tempo: 'fast', context: 'party' },

    // Aggressive / Dark / Angry
    { words: ['rage', 'anger', 'destroy', 'war', 'fight', 'kill', 'death', 'blood', 'savage', 'brutal', 'monster', 'demon', 'hell', 'chaos', 'madness', 'wrath', 'fury', 'scream', 'burn', 'revenge', 'villain', 'enemy', 'gangsta', 'thug', 'murder'],
      mood: 'aggressive', energy: 0.85, valence: 0.2, danceability: 0.5, tempo: 'fast', context: 'workout' },

    // Nostalgic / Retro
    { words: ['remember', 'memories', 'old', 'days', 'throwback', 'back then', 'used to', 'once', 'yesterday', 'vintage', 'retro', 'classic', 'timeless', 'flashback', '90s', '80s', '2000s', 'rewind'],
      mood: 'nostalgic', energy: 0.4, valence: 0.45, danceability: 0.35, tempo: 'medium', context: 'driving' },

    // Dark / Moody
    { words: ['dark', 'shadow', 'midnight', 'phantom', 'abyss', 'void', 'numb', 'cold', 'frozen', 'buried', 'sinking', 'drowning', 'toxic', 'poison', 'wicked', 'sinister', 'twisted', 'fallen', 'obsess', 'paranoid', 'insomnia'],
      mood: 'dark', energy: 0.45, valence: 0.15, danceability: 0.35, tempo: 'medium', context: 'night' },

    // Dreamy / Ethereal
    { words: ['dream', 'wonder', 'fantasy', 'magic', 'fairy', 'enchant', 'celestial', 'cosmic', 'galaxy', 'stars', 'sky', 'heaven', 'angel', 'ethereal', 'surreal', 'illusion', 'aurora', 'nebula', 'infinity'],
      mood: 'dreamy', energy: 0.3, valence: 0.5, danceability: 0.25, tempo: 'slow', context: 'relaxing' },

    // Motivational / Empowering
    { words: ['rise', 'stronger', 'power', 'unstoppable', 'conquer', 'champion', 'warrior', 'brave', 'fearless', 'believe', 'inspire', 'king', 'queen', 'legend', 'glory', 'victory', 'triumph', 'hustle', 'grind', 'winner', 'never give up'],
      mood: 'motivational', energy: 0.75, valence: 0.7, danceability: 0.55, tempo: 'medium', context: 'workout' },
];

// ═══════════════════════════════════════════════════════════════════
//  GENRE → AUDIO FEATURES MAPPING
//
//  When we know the genre (from autoplay engine's detection),
//  we can set baseline features. This acts like Spotify's
//  genre-level audio feature averages.
// ═══════════════════════════════════════════════════════════════════

const GENRE_FEATURES = {
    'bollywood':       { energy: 0.5, valence: 0.5, danceability: 0.5, tempo: 'medium', mood: 'romantic', context: 'driving' },
    'punjabi pop':     { energy: 0.75, valence: 0.7, danceability: 0.8, tempo: 'fast', mood: 'energetic', context: 'party' },
    'punjabi hip hop': { energy: 0.8, valence: 0.6, danceability: 0.75, tempo: 'fast', mood: 'aggressive', context: 'party' },
    'kollywood':       { energy: 0.6, valence: 0.55, danceability: 0.6, tempo: 'medium', mood: 'romantic', context: 'driving' },
    'k-pop':           { energy: 0.8, valence: 0.75, danceability: 0.85, tempo: 'fast', mood: 'energetic', context: 'party' },
    'j-pop':           { energy: 0.65, valence: 0.65, danceability: 0.6, tempo: 'medium', mood: 'happy', context: 'driving' },
    'reggaeton':       { energy: 0.8, valence: 0.7, danceability: 0.9, tempo: 'fast', mood: 'energetic', context: 'party' },
    'latin pop':       { energy: 0.65, valence: 0.7, danceability: 0.7, tempo: 'medium', mood: 'happy', context: 'party' },
    'afrobeats':       { energy: 0.7, valence: 0.7, danceability: 0.85, tempo: 'medium', mood: 'happy', context: 'party' },
    'hip hop':         { energy: 0.7, valence: 0.45, danceability: 0.7, tempo: 'medium', mood: 'aggressive', context: 'driving' },
    'rap':             { energy: 0.75, valence: 0.4, danceability: 0.65, tempo: 'fast', mood: 'aggressive', context: 'workout' },
    'trap':            { energy: 0.8, valence: 0.35, danceability: 0.7, tempo: 'fast', mood: 'dark', context: 'night' },
    'drill':           { energy: 0.85, valence: 0.25, danceability: 0.65, tempo: 'fast', mood: 'aggressive', context: 'workout' },
    'pop':             { energy: 0.6, valence: 0.65, danceability: 0.65, tempo: 'medium', mood: 'happy', context: 'driving' },
    'indie':           { energy: 0.45, valence: 0.45, danceability: 0.4, tempo: 'medium', mood: 'nostalgic', context: 'relaxing' },
    'alternative':     { energy: 0.55, valence: 0.4, danceability: 0.45, tempo: 'medium', mood: 'dark', context: 'night' },
    'rock':            { energy: 0.75, valence: 0.5, danceability: 0.5, tempo: 'fast', mood: 'energetic', context: 'workout' },
    'metal':           { energy: 0.95, valence: 0.25, danceability: 0.4, tempo: 'fast', mood: 'aggressive', context: 'workout' },
    'punk':            { energy: 0.85, valence: 0.45, danceability: 0.55, tempo: 'fast', mood: 'aggressive', context: 'workout' },
    'r&b':             { energy: 0.45, valence: 0.5, danceability: 0.6, tempo: 'medium', mood: 'romantic', context: 'night' },
    'rnb':             { energy: 0.45, valence: 0.5, danceability: 0.6, tempo: 'medium', mood: 'romantic', context: 'night' },
    'soul':            { energy: 0.4, valence: 0.55, danceability: 0.5, tempo: 'slow', mood: 'romantic', context: 'night' },
    'jazz':            { energy: 0.35, valence: 0.5, danceability: 0.45, tempo: 'medium', mood: 'chill', context: 'relaxing' },
    'blues':           { energy: 0.4, valence: 0.3, danceability: 0.35, tempo: 'slow', mood: 'sad', context: 'night' },
    'edm':             { energy: 0.9, valence: 0.75, danceability: 0.9, tempo: 'fast', mood: 'energetic', context: 'party' },
    'house':           { energy: 0.8, valence: 0.7, danceability: 0.85, tempo: 'fast', mood: 'energetic', context: 'party' },
    'techno':          { energy: 0.85, valence: 0.5, danceability: 0.8, tempo: 'fast', mood: 'dark', context: 'party' },
    'trance':          { energy: 0.75, valence: 0.6, danceability: 0.7, tempo: 'fast', mood: 'dreamy', context: 'party' },
    'dubstep':         { energy: 0.9, valence: 0.4, danceability: 0.6, tempo: 'fast', mood: 'aggressive', context: 'party' },
    'lofi':            { energy: 0.2, valence: 0.35, danceability: 0.3, tempo: 'slow', mood: 'chill', context: 'focus' },
    'lo-fi':           { energy: 0.2, valence: 0.35, danceability: 0.3, tempo: 'slow', mood: 'chill', context: 'focus' },
    'ambient':         { energy: 0.1, valence: 0.4, danceability: 0.1, tempo: 'slow', mood: 'dreamy', context: 'focus' },
    'classical':       { energy: 0.3, valence: 0.45, danceability: 0.15, tempo: 'slow', mood: 'dreamy', context: 'focus' },
    'country':         { energy: 0.5, valence: 0.6, danceability: 0.5, tempo: 'medium', mood: 'nostalgic', context: 'driving' },
    'folk':            { energy: 0.35, valence: 0.5, danceability: 0.35, tempo: 'slow', mood: 'nostalgic', context: 'relaxing' },
    'acoustic':        { energy: 0.3, valence: 0.45, danceability: 0.3, tempo: 'slow', mood: 'chill', context: 'relaxing' },
    'phonk':           { energy: 0.85, valence: 0.3, danceability: 0.75, tempo: 'fast', mood: 'dark', context: 'driving' },
    'synthwave':       { energy: 0.65, valence: 0.55, danceability: 0.65, tempo: 'medium', mood: 'nostalgic', context: 'driving' },
    'bedroom pop':     { energy: 0.3, valence: 0.45, danceability: 0.4, tempo: 'slow', mood: 'dreamy', context: 'night' },
    'dream pop':       { energy: 0.3, valence: 0.5, danceability: 0.35, tempo: 'slow', mood: 'dreamy', context: 'night' },
    'shoegaze':        { energy: 0.5, valence: 0.35, danceability: 0.3, tempo: 'medium', mood: 'dreamy', context: 'night' },
    'gospel':          { energy: 0.6, valence: 0.8, danceability: 0.5, tempo: 'medium', mood: 'motivational', context: 'driving' },
    'reggae':          { energy: 0.5, valence: 0.65, danceability: 0.7, tempo: 'medium', mood: 'chill', context: 'relaxing' },
    'funk':            { energy: 0.7, valence: 0.75, danceability: 0.85, tempo: 'medium', mood: 'happy', context: 'party' },
    'disco':           { energy: 0.75, valence: 0.8, danceability: 0.9, tempo: 'fast', mood: 'energetic', context: 'party' },
};

// ═══════════════════════════════════════════════════════════════════
//  ARTIST → DEFAULT FEATURES
//  Popular artists whose vibe is well-known
// ═══════════════════════════════════════════════════════════════════

const ARTIST_FEATURES = new Map([
    ['arijit singh',     { energy: 0.3, valence: 0.25, mood: 'sad', tempo: 'slow' }],
    ['atif aslam',       { energy: 0.35, valence: 0.3, mood: 'romantic', tempo: 'slow' }],
    ['shreya ghoshal',   { energy: 0.3, valence: 0.4, mood: 'romantic', tempo: 'slow' }],
    ['neha kakkar',      { energy: 0.7, valence: 0.65, mood: 'energetic', tempo: 'fast' }],
    ['badshah',          { energy: 0.8, valence: 0.6, mood: 'energetic', tempo: 'fast' }],
    ['ap dhillon',       { energy: 0.75, valence: 0.55, mood: 'dark', tempo: 'medium' }],
    ['diljit dosanjh',   { energy: 0.7, valence: 0.65, mood: 'happy', tempo: 'fast' }],
    ['sidhu moose wala', { energy: 0.8, valence: 0.35, mood: 'aggressive', tempo: 'medium' }],
    ['taylor swift',     { energy: 0.5, valence: 0.5, mood: 'nostalgic', tempo: 'medium' }],
    ['the weeknd',       { energy: 0.55, valence: 0.3, mood: 'dark', tempo: 'medium' }],
    ['billie eilish',    { energy: 0.35, valence: 0.2, mood: 'dark', tempo: 'slow' }],
    ['drake',            { energy: 0.55, valence: 0.4, mood: 'chill', tempo: 'medium' }],
    ['kendrick lamar',   { energy: 0.7, valence: 0.35, mood: 'aggressive', tempo: 'fast' }],
    ['travis scott',     { energy: 0.85, valence: 0.4, mood: 'dark', tempo: 'fast' }],
    ['olivia rodrigo',   { energy: 0.6, valence: 0.35, mood: 'sad', tempo: 'medium' }],
    ['doja cat',         { energy: 0.8, valence: 0.7, mood: 'energetic', tempo: 'fast' }],
    ['bad bunny',        { energy: 0.8, valence: 0.65, mood: 'energetic', tempo: 'fast' }],
    ['bts',              { energy: 0.75, valence: 0.7, mood: 'energetic', tempo: 'fast' }],
    ['blackpink',        { energy: 0.85, valence: 0.7, mood: 'energetic', tempo: 'fast' }],
    ['stray kids',       { energy: 0.9, valence: 0.6, mood: 'aggressive', tempo: 'fast' }],
    ['burna boy',        { energy: 0.65, valence: 0.65, mood: 'chill', tempo: 'medium' }],
    ['wizkid',           { energy: 0.55, valence: 0.6, mood: 'chill', tempo: 'medium' }],
    ['ed sheeran',       { energy: 0.4, valence: 0.5, mood: 'romantic', tempo: 'medium' }],
    ['adele',            { energy: 0.35, valence: 0.2, mood: 'sad', tempo: 'slow' }],
    ['post malone',      { energy: 0.55, valence: 0.35, mood: 'dark', tempo: 'medium' }],
    ['juice wrld',       { energy: 0.6, valence: 0.2, mood: 'sad', tempo: 'medium' }],
    ['xxxtentacion',     { energy: 0.65, valence: 0.15, mood: 'sad', tempo: 'medium' }],
    ['lana del rey',     { energy: 0.3, valence: 0.3, mood: 'dreamy', tempo: 'slow' }],
    ['arctic monkeys',   { energy: 0.6, valence: 0.4, mood: 'dark', tempo: 'medium' }],
    ['imagine dragons',  { energy: 0.8, valence: 0.55, mood: 'motivational', tempo: 'fast' }],
    ['eminem',           { energy: 0.85, valence: 0.3, mood: 'aggressive', tempo: 'fast' }],
    ['kanye west',       { energy: 0.7, valence: 0.4, mood: 'aggressive', tempo: 'medium' }],
    ['a.r. rahman',      { energy: 0.5, valence: 0.5, mood: 'dreamy', tempo: 'medium' }],
    ['pritam',           { energy: 0.55, valence: 0.55, mood: 'romantic', tempo: 'medium' }],
    ['anirudh',          { energy: 0.7, valence: 0.6, mood: 'energetic', tempo: 'fast' }],
]);

// ═══════════════════════════════════════════════════════════════════
//  VALID MOOD TRANSITIONS — Spotify's mood smoothing
//
//  Spotify never jumps from "sad" to "party EDM". It flows:
//    sad → chill → hopeful → happy
//    dark → moody → energetic
//    romantic → dreamy → chill
//
//  This map defines which moods can follow which, preventing
//  jarring emotional whiplash in the autoplay queue.
// ═══════════════════════════════════════════════════════════════════

const MOOD_TRANSITIONS = {
    sad:          ['sad', 'chill', 'romantic', 'dark', 'nostalgic', 'dreamy'],
    romantic:     ['romantic', 'chill', 'sad', 'dreamy', 'happy', 'nostalgic'],
    chill:        ['chill', 'dreamy', 'romantic', 'happy', 'nostalgic', 'sad'],
    happy:        ['happy', 'energetic', 'chill', 'motivational', 'nostalgic', 'romantic'],
    energetic:    ['energetic', 'happy', 'aggressive', 'motivational', 'dark'],
    aggressive:   ['aggressive', 'energetic', 'dark', 'motivational'],
    nostalgic:    ['nostalgic', 'sad', 'chill', 'romantic', 'dreamy', 'happy'],
    dark:         ['dark', 'aggressive', 'sad', 'chill', 'dreamy', 'nostalgic'],
    dreamy:       ['dreamy', 'chill', 'romantic', 'nostalgic', 'sad', 'happy'],
    motivational: ['motivational', 'energetic', 'happy', 'aggressive'],
};

// ═══════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect mood and audio features from a track's metadata.
 *
 * @param {string} title - Song title
 * @param {string} author - Artist name
 * @param {string|null} genre - Detected genre (from autoplay engine)
 * @returns {{ mood: string, energy: number, valence: number, danceability: number, tempo: string, context: string }}
 */
export function detectMood(title, author, genre = null) {
    const titleLower = (title || '').toLowerCase();
    const authorLower = (author || '').toLowerCase();
    const text = `${titleLower} ${authorLower}`;

    // ── Layer 1: Artist knowledge (highest confidence) ──
    for (const [artist, features] of ARTIST_FEATURES) {
        if (authorLower.includes(artist)) {
            // Artist match gives us a strong baseline, but title keywords can adjust
            const titleAdjustments = getKeywordVotes(titleLower);
            return mergeFeatures(features, titleAdjustments, genre);
        }
    }

    // ── Layer 2: Genre baseline ──
    const genreBaseline = genre ? GENRE_FEATURES[genre.toLowerCase()] : null;

    // ── Layer 3: Title keyword analysis ──
    const keywordVotes = getKeywordVotes(text);

    if (keywordVotes) {
        return mergeFeatures(keywordVotes, null, genre);
    }

    // ── Layer 4: Genre-only fallback ──
    if (genreBaseline) {
        return { ...genreBaseline };
    }

    // ── Layer 5: Neutral default ──
    return {
        mood: 'chill',
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        tempo: 'medium',
        context: 'driving',
    };
}

/**
 * Detect mood for a track object (convenience wrapper)
 */
export function detectTrackMood(track, genre = null) {
    if (!track?.info) return detectMood('', '', genre);
    return detectMood(track.info.title, track.info.author, genre);
}

/**
 * Compute average mood features across multiple tracks (session profile)
 */
export function getSessionMoodProfile(tracks, genres = []) {
    if (!tracks || tracks.length === 0) return null;

    let totalEnergy = 0, totalValence = 0, totalDanceability = 0;
    const moodCounts = {};
    const contextCounts = {};
    const tempoCounts = {};
    const genre = genres[0] || null;

    for (const track of tracks) {
        const features = detectTrackMood(track, genre);
        totalEnergy += features.energy;
        totalValence += features.valence;
        totalDanceability += features.danceability;
        moodCounts[features.mood] = (moodCounts[features.mood] || 0) + 1;
        contextCounts[features.context] = (contextCounts[features.context] || 0) + 1;
        tempoCounts[features.tempo] = (tempoCounts[features.tempo] || 0) + 1;
    }

    const n = tracks.length;
    const dominantMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'chill';
    const dominantContext = Object.entries(contextCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'driving';
    const dominantTempo = Object.entries(tempoCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'medium';

    return {
        mood: dominantMood,
        energy: +(totalEnergy / n).toFixed(2),
        valence: +(totalValence / n).toFixed(2),
        danceability: +(totalDanceability / n).toFixed(2),
        tempo: dominantTempo,
        context: dominantContext,
        moodDistribution: moodCounts,
    };
}

/**
 * Check if a mood transition is smooth (not jarring)
 *
 * @returns {boolean} true if the transition is acceptable
 */
export function isSmoothTransition(fromMood, toMood) {
    if (!fromMood || !toMood) return true;
    const allowed = MOOD_TRANSITIONS[fromMood];
    if (!allowed) return true; // unknown mood = allow it
    return allowed.includes(toMood);
}

/**
 * Get the list of allowed next moods for smooth transition
 */
export function getAllowedNextMoods(currentMood) {
    return MOOD_TRANSITIONS[currentMood] || Object.keys(MOOD_TRANSITIONS);
}

/**
 * Get genre features directly (used by similarity engine)
 */
export function getGenreFeatures(genre) {
    if (!genre) return null;
    return GENRE_FEATURES[genre.toLowerCase()] || null;
}

// ═══════════════════════════════════════════════════════════════════
//  INTERNAL
// ═══════════════════════════════════════════════════════════════════

function getKeywordVotes(text) {
    let bestMatch = null;
    let bestScore = 0;

    for (const category of MOOD_KEYWORDS) {
        let hits = 0;
        for (const word of category.words) {
            if (text.includes(word)) hits++;
        }
        if (hits > bestScore) {
            bestScore = hits;
            bestMatch = category;
        }
    }

    if (bestMatch && bestScore > 0) {
        return {
            mood: bestMatch.mood,
            energy: bestMatch.energy,
            valence: bestMatch.valence,
            danceability: bestMatch.danceability,
            tempo: bestMatch.tempo,
            context: bestMatch.context,
        };
    }
    return null;
}

function mergeFeatures(primary, secondary, genre) {
    const genreBaseline = genre ? GENRE_FEATURES[genre.toLowerCase()] : null;

    // Start with primary
    const result = {
        mood: primary.mood,
        energy: primary.energy ?? 0.5,
        valence: primary.valence ?? 0.5,
        danceability: primary.danceability ?? 0.5,
        tempo: primary.tempo || 'medium',
        context: primary.context || 'driving',
    };

    // Title keywords can adjust energy/valence by small amount (title overrides artist for mood)
    if (secondary) {
        if (secondary.mood) result.mood = secondary.mood; // title mood overrides if present
        result.energy = result.energy * 0.6 + secondary.energy * 0.4;
        result.valence = result.valence * 0.6 + secondary.valence * 0.4;
    }

    // Genre provides baseline if features are missing
    if (genreBaseline) {
        result.danceability = result.danceability || genreBaseline.danceability;
        if (!result.context || result.context === 'driving') {
            result.context = genreBaseline.context;
        }
    }

    result.energy = +result.energy.toFixed(2);
    result.valence = +result.valence.toFixed(2);
    result.danceability = +result.danceability.toFixed(2);

    return result;
}
