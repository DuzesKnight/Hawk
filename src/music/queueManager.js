import { config } from '../config/env.js';
import { Guild } from '../database/schemas/Guild.js';
import { logger } from '../utils/logger.js';
import mongoose from 'mongoose';

/**
 * Per-guild queue
 */
export class GuildQueue {
    constructor(guildId) {
        this.guildId = guildId;
        this.tracks = [];
        this.currentTrack = null;
        this.currentPosition = 0;
        this.loopMode = 'off';      // 'off' | 'track' | 'queue'
        this.autoplay = true;
        this.volume = config.defaultVolume;
        this.paused = false;
        this.twentyFourSeven = false;
        this.voiceChannelId = null;
        this.textChannel = null;
        this.playerMessageId = null;
        this.updateInterval = null;
        this.history = [];           // last 20 tracks for AI context
        this.currentMood = null;     // mood features of current track (from moodEngine)
        this._settingsLoaded = false;

        // Async init — load persisted settings from DB
        this._loadGuildSettings();
    }

    /**
     * Load saved guild settings (volume, autoplay, loop) from database
     */
    async _loadGuildSettings() {
        if (mongoose.connection.readyState !== 1) return;
        try {
            const doc = await Guild.findOne({ guildId: this.guildId }).lean();
            if (doc) {
                if (doc.volume != null) this.volume = doc.volume;
                if (doc.autoplay != null) this.autoplay = doc.autoplay;
                if (doc.loopMode) this.loopMode = doc.loopMode;
                if (doc.playerMessageId) this.playerMessageId = doc.playerMessageId;
                if (doc.twentyFourSeven != null) this.twentyFourSeven = doc.twentyFourSeven;
            }
            this._settingsLoaded = true;
        } catch (err) {
            logger.debug(`Failed to load guild settings for ${this.guildId}: ${err.message}`);
        }
    }

    /**
     * Persist current settings to database (debounced — call freely)
     */
    saveSettings() {
        if (mongoose.connection.readyState !== 1) return;
        // Debounce: clear any pending save, schedule a new one in 2s
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            try {
                await Guild.findOneAndUpdate(
                    { guildId: this.guildId },
                    {
                        guildId: this.guildId,
                        volume: this.volume,
                        autoplay: this.autoplay,
                        loopMode: this.loopMode,
                        twentyFourSeven: this.twentyFourSeven,
                    },
                    { upsert: true }
                );
            } catch (err) {
                logger.debug(`Failed to save guild settings for ${this.guildId}: ${err.message}`);
            }
        }, 2000);
    }

    /**
     * Add a track to the queue
     * @returns {object|null} queued item, or null if queue is full or duplicate
     */
    add(trackData, requestedBy) {
        if (this.tracks.length >= config.maxQueueSize) {
            return null; // Queue full
        }

        // Duplicate check: skip if same URI already in queue
        if (trackData.info?.uri && this.tracks.some(t => t.info?.uri === trackData.info.uri)) {
            return { _duplicate: true, info: trackData.info };
        }

        const queueItem = {
            ...trackData,
            requestedBy: requestedBy?.displayName || requestedBy?.user?.username || 'Unknown',
            requestedById: requestedBy?.id || requestedBy?.user?.id || null,
            addedAt: Date.now(),
        };
        this.tracks.push(queueItem);
        return queueItem;
    }

    /**
     * Add multiple tracks (playlist)
     * Automatically trims to maxQueueSize
     */
    addMany(tracksData, requestedBy) {
        const available = config.maxQueueSize - this.tracks.length;
        const toAdd = tracksData.slice(0, Math.max(available, 0));

        const items = toAdd.map(t => ({
            ...t,
            requestedBy: requestedBy?.displayName || requestedBy?.user?.username || 'Unknown',
            requestedById: requestedBy?.id || requestedBy?.user?.id || null,
            addedAt: Date.now(),
        }));
        this.tracks.push(...items);
        return items;
    }

    /**
     * Get the next track based on loop mode
     */
    next() {
        // Store current in history
        if (this.currentTrack) {
            this.history.push(this.currentTrack);
            if (this.history.length > 20) this.history.shift();
        }

        if (this.loopMode === 'track' && this.currentTrack) {
            return this.currentTrack;
        }

        if (this.loopMode === 'queue' && this.currentTrack) {
            this.tracks.push(this.currentTrack);
        }

        const next = this.tracks.shift() || null;
        this.currentTrack = next;
        this.currentPosition = 0;
        return next;
    }

    /**
     * Get previous track from history
     */
    previous() {
        if (this.history.length === 0) return null;
        // Put current back at front
        if (this.currentTrack) {
            this.tracks.unshift(this.currentTrack);
        }
        this.currentTrack = this.history.pop();
        this.currentPosition = 0;
        return this.currentTrack;
    }

    /**
     * Shuffle the queue
     */
    shuffle() {
        for (let i = this.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
        }
    }

    /**
     * Clear the queue
     */
    clear() {
        this.tracks = [];
    }

    /**
     * Remove a track by index
     */
    remove(index) {
        if (index < 0 || index >= this.tracks.length) return null;
        return this.tracks.splice(index, 1)[0];
    }

    /**
     * Check if queue is empty
     */
    get isEmpty() {
        return this.tracks.length === 0;
    }

    /**
     * Get queue size
     */
    get size() {
        return this.tracks.length;
    }

    /**
     * Destroy and clean up
     */
    destroy() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        clearTimeout(this._saveTimer);
        this.tracks = [];
        this.currentTrack = null;
        this.currentMood = null;
        this.history = [];
    }
}
