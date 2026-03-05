import { Shoukaku, Connectors } from 'shoukaku';
import { Collection, MessageFlags } from 'discord.js';
import { lavalinkNodes } from '../config/lavalink.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { GuildQueue } from './queueManager.js';
import { resolveTrack } from './sourceResolver.js';
import { createPlayerEmbed, createControlButtons, createExtraButtons } from '../ui/playerEmbed.js';
import { getAutoplayTrack, clearAutoplayBuffer } from './autoplayEngine.js';
import { detectTrackMood } from '../ai/moodEngine.js';

export class PlayerManager {
    constructor(client) {
        this.client = client;
        this.queues = new Collection();
        this._playNextLocks = new Set(); // Prevent concurrent _playNext

        // Initialize Shoukaku
        this.shoukaku = new Shoukaku(
            new Connectors.DiscordJS(client),
            lavalinkNodes,
            {
                moveOnDisconnect: false,
                resumable: false,
                reconnectTries: 5,
                reconnectInterval: 3000,
                restTimeout: 30000,
                nodeResolver: (nodes) => {
                    // State 1 = CONNECTED in Shoukaku v4
                    return [...nodes.values()]
                        .filter(n => n.state === 1)
                        .sort((a, b) => a.penalties - b.penalties)
                        .shift() || null;
                },
            }
        );

        this.shoukaku.on('ready', (name) => {
            logger.info(`Lavalink node "${name}" connected`);
        });

        this.shoukaku.on('error', (name, err) => {
            logger.error(`Lavalink node "${name}" error: ${err.message}`);
        });

        this.shoukaku.on('close', (name, code, reason) => {
            logger.warn(`Lavalink node "${name}" closed [${code}]: ${reason}`);
        });

        this.shoukaku.on('disconnect', (name, players, moved) => {
            logger.warn(`Lavalink node "${name}" disconnected. Players: ${players.size}, Moved: ${moved}`);
        });
    }

    async _waitForNodeReady(timeoutMs = 15000, intervalMs = 500) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const node = this.shoukaku.options.nodeResolver(this.shoukaku.nodes);
            if (node) return node;
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return null;
    }

    /**
     * Get or create a queue for a guild
     */
    getQueue(guildId) {
        if (!this.queues.has(guildId)) {
            this.queues.set(guildId, new GuildQueue(guildId));
        }
        return this.queues.get(guildId);
    }

    /**
     * Main play function
     */
    async play(guild, voiceChannel, query, member, textChannel) {
        const queue = this.getQueue(guild.id);
        queue.textChannel = textChannel;
        queue.voiceChannelId = voiceChannel.id;

        // User is manually queuing — reset autoplay buffer so future
        // autoplay recommendations are based on the new session context
        clearAutoplayBuffer(guild.id);

        const readyNode = await this._waitForNodeReady();
        if (!readyNode) {
            const msg = await textChannel.send('❌ Lavalink is not connected yet (no active node). Wait a few seconds and try again.');
            setTimeout(() => msg.delete().catch(() => {}), 7000);
            return null;
        }

        // Resolve the track
        const resolved = await resolveTrack(this.shoukaku, query);
        if (!resolved) {
            const msg = await textChannel.send('❌ No results found for that query.');
            setTimeout(() => msg.delete().catch(() => {}), 5000);
            return null;
        }

        // Handle playlists
        if (resolved._playlist) {
            const playlistTracks = resolved._playlist.tracks.map(t => ({
                track: t.encoded,
                info: {
                    title: t.info.title,
                    author: t.info.author,
                    uri: t.info.uri,
                    length: t.info.length,
                    artworkUrl: t.info.artworkUrl || null,
                    sourceName: t.info.sourceName || 'unknown',
                    isStream: t.info.isStream || false,
                },
            }));
            const added = queue.addMany(playlistTracks, member);
            const msg = await textChannel.send(
                added.length < playlistTracks.length
                    ? `📋 Added **${added.length}/${playlistTracks.length}** tracks from **${resolved._playlist.name}** (queue limit reached)`
                    : `📋 Added **${added.length}** tracks from **${resolved._playlist.name}**`
            );
            setTimeout(() => msg.delete().catch(() => {}), 5000);
        } else {
            const result = queue.add(resolved, member);
            if (result === null) {
                const msg = await textChannel.send(`❌ Queue is full (max ${config.maxQueueSize}).`);
                setTimeout(() => msg.delete().catch(() => {}), 5000);
                return null;
            }
            // Duplicate — silently re-add without extra warning
            if (result?._duplicate) {
                queue.tracks.push({
                    ...resolved,
                    requestedBy: member?.displayName || member?.user?.username || 'Unknown',
                    requestedById: member?.id || member?.user?.id || null,
                    addedAt: Date.now(),
                });
            }
        }

        // Get or create player
        let player = this.shoukaku.players.get(guild.id);

        if (!player) {
            try {
                player = await this.shoukaku.joinVoiceChannel({
                    guildId: guild.id,
                    channelId: voiceChannel.id,
                    shardId: 0,
                    deaf: true,
                });
            } catch (err) {
                logger.error(`Failed to create player in ${guild.id}: ${err.message}`);
                const msg = await textChannel.send('❌ No active Lavalink node is available right now. Please check primary/backup Lavalink and try again.').catch(() => null);
                if (msg) setTimeout(() => msg.delete().catch(() => {}), 7000);
                return null;
            }

            // Set up player event handlers
            this._setupPlayerEvents(player, guild.id);
        }

        // If nothing is currently playing, start playback
        if (!queue.currentTrack) {
            await this._playNext(guild.id, player);
        } else {
            // Just send a queued notification
            if (!resolved._playlist) {
                const msg = await textChannel.send(`🎶 Queued: **${resolved.info.title}** by ${resolved.info.author}`);
                setTimeout(() => msg.delete().catch(() => {}), 5000);
            }
        }

        return resolved;
    }

    /**
     * Play the next track in queue.
     * Guarded against concurrent calls (e.g. exception + end firing together).
     */
    async _playNext(guildId, player) {
        // Concurrency guard — only one _playNext at a time per guild
        if (this._playNextLocks.has(guildId)) {
            logger.debug(`_playNext already running for ${guildId} — skipping`);
            return;
        }
        this._playNextLocks.add(guildId);

        try {
            const queue = this.getQueue(guildId);

            const next = queue.next();
            if (!next) {
                // Queue empty — try autoplay
                if (queue.autoplay) {
                    const autoTrack = await getAutoplayTrack(this.shoukaku, queue);
                    if (autoTrack) {
                        // Directly set as current track (bypass queue add/next cycle)
                        queue.currentTrack = autoTrack;
                        queue.currentTrack.requestedBy = '🤖 AutoPlay';
                        queue.currentTrack.requestedById = null;
                        queue.currentTrack.addedAt = Date.now();
                        queue.currentPosition = 0;
                        return await this._startTrack(guildId, player, autoTrack, queue);
                    }
                }

                // Nothing to play — idle
                queue.currentTrack = null;
                await player.stopTrack().catch(() => {});
                await this._updatePlayerEmbed(queue, true);
                this._stopUpdateInterval(queue);

                // Leave voice after 2 minutes of inactivity (unless 24/7)
                setTimeout(() => {
                    const currentQueue = this.queues.get(guildId);
                    if (currentQueue && !currentQueue.currentTrack && !currentQueue.twentyFourSeven) {
                        this.destroy(guildId);
                    }
                }, 120000);
                return;
            }

            await this._startTrack(guildId, player, next, queue);
        } finally {
            this._playNextLocks.delete(guildId);
        }
    }

    /**
     * Start playing a specific track
     */
    async _startTrack(guildId, player, trackData, queue) {
        try {
            if (trackData.track) {
                // Lavalink encoded track
                await player.playTrack({ track: { encoded: trackData.track } });
            } else if (trackData.info?.directUrl) {
                // yt-dlp fallback — resolve the original URI through Lavalink HTTP source
                // Direct googlevideo URLs are ephemeral/auth-gated, so re-resolve via Lavalink
                const node = await this._waitForNodeReady(4000, 300);
                if (node) {
                    // Try to resolve the original URI (e.g. youtube.com link) through Lavalink
                    const originalUri = trackData.info.uri;
                    let resolved = null;

                    if (originalUri && originalUri !== trackData.info.directUrl) {
                        resolved = await node.rest.resolve(originalUri).catch(() => null);
                    }

                    // Fallback: try the direct URL as HTTP source
                    if (!resolved?.data?.encoded) {
                        resolved = await node.rest.resolve(trackData.info.directUrl).catch(() => null);
                    }

                    if (resolved?.data?.encoded) {
                        await player.playTrack({ track: { encoded: resolved.data.encoded } });
                    } else if (resolved?.data?.tracks?.[0]?.encoded) {
                        await player.playTrack({ track: { encoded: resolved.data.tracks[0].encoded } });
                    } else {
                        throw new Error('Could not resolve yt-dlp track through Lavalink');
                    }
                } else {
                    throw new Error('No Lavalink node available for direct URL fallback');
                }
            } else {
                throw new Error('Track has no encoded data and no direct URL');
            }

            player.setGlobalVolume(queue.volume);
            queue.currentPosition = 0;
            queue.paused = false;

            // Detect mood of current track (used by autoplay for transition smoothing)
            try {
                queue.currentMood = detectTrackMood(trackData);
            } catch { queue.currentMood = null; }

            // Update the player embed
            await this._updatePlayerEmbed(queue);
            this._startUpdateInterval(queue);
        } catch (err) {
            logger.error(`Error starting track in ${guildId}: ${err.message}`);
            // Skip to next
            await this._playNext(guildId, player);
        }
    }

    /**
     * Set up player event handlers
     */
    _setupPlayerEvents(player, guildId) {
        // Consecutive failure counter to prevent infinite skip loops
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;

        player.on('start', () => {
            logger.debug(`Track started in guild ${guildId}`);
            consecutiveFailures = 0; // Reset on successful start
        });

        player.on('end', async (data) => {
            if (data.reason === 'replaced') return;
            if (data.reason === 'stopped') return;

            await this._playNext(guildId, player);
        });

        player.on('stuck', async () => {
            logger.warn(`Track stuck in guild ${guildId} — skipping`);
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                logger.error(`Guild ${guildId}: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping playback`);
                const queue = this.getQueue(guildId);
                if (queue.textChannel) {
                    const msg = await queue.textChannel.send('❌ Multiple tracks failed in a row. Playback stopped. YouTube may be blocked on this server — try SoundCloud or Spotify links.').catch(() => null);
                    if (msg) setTimeout(() => msg.delete().catch(() => {}), 15000);
                }
                await this.stop(guildId);
                return;
            }
            await this._playNext(guildId, player);
        });

        player.on('exception', async (data) => {
            const errMsg = data?.exception?.message || data?.message || JSON.stringify(data) || 'Unknown error';
            const severity = data?.exception?.severity || 'UNKNOWN';
            logger.error(`Track exception in guild ${guildId} [${severity}]: ${errMsg}`);

            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                logger.error(`Guild ${guildId}: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping playback`);
                const queue = this.getQueue(guildId);
                if (queue.textChannel) {
                    const msg = await queue.textChannel.send('❌ Multiple tracks failed in a row. Playback stopped. YouTube may be blocked on this server — try SoundCloud or Spotify links instead.').catch(() => null);
                    if (msg) setTimeout(() => msg.delete().catch(() => {}), 15000);
                }
                await this.stop(guildId);
                return;
            }

            const queue = this.getQueue(guildId);
            if (queue.textChannel) {
                const msg = await queue.textChannel.send(`⚠️ Playback error — skipping track.`).catch(() => null);
                if (msg) setTimeout(() => msg.delete().catch(() => {}), 5000);
            }
            await this._playNext(guildId, player);
        });

        player.on('closed', () => {
            logger.debug(`Player connection closed in guild ${guildId}`);
        });

        player.on('update', (data) => {
            const queue = this.queues.get(guildId);
            if (queue && data.state?.position) {
                queue.currentPosition = data.state.position;
            }
        });
    }

    /**
     * Start the embed update interval
     */
    _startUpdateInterval(queue) {
        this._stopUpdateInterval(queue);
        queue.updateInterval = setInterval(async () => {
            if (queue.currentTrack) {
                await this._updatePlayerEmbed(queue);
            }
        }, config.embedUpdateInterval);
    }

    /**
     * Stop the embed update interval
     */
    _stopUpdateInterval(queue) {
        if (queue.updateInterval) {
            clearInterval(queue.updateInterval);
            queue.updateInterval = null;
        }
    }

    /**
     * Update or create the player embed message
     */
    async _updatePlayerEmbed(queue, idle = false) {
        if (!queue.textChannel) return;

        try {
            const embed = createPlayerEmbed(queue, idle);
            const row1 = createControlButtons(queue);
            const row2 = createExtraButtons(queue);

            if (queue.playerMessageId) {
                try {
                    const msg = await queue.textChannel.messages.fetch(queue.playerMessageId);
                    await msg.edit({ embeds: [embed], components: [row1, row2] });
                    return;
                } catch {
                    // Message deleted or not found — create new one
                }
            }

            const msg = await queue.textChannel.send({ embeds: [embed], components: [row1, row2] });
            queue.playerMessageId = msg.id;
        } catch (err) {
            logger.debug(`Embed update failed: ${err.message}`);
        }
    }

    /**
     * Handle player button interactions
     */
    async handleButton(interaction) {
        const guildId = interaction.guildId;
        const queue = this.queues.get(guildId);
        const player = this.shoukaku.players.get(guildId);

        if (!queue || !player) {
            return interaction.reply({ content: '❌ Nothing is playing.', flags: MessageFlags.Ephemeral });
        }

        // Check if user is in the same voice channel
        const memberVoice = interaction.member?.voice?.channel;
        if (!memberVoice || memberVoice.id !== queue.voiceChannelId) {
            return interaction.reply({ content: '🔇 Join the voice channel first!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferUpdate().catch(() => {});

        switch (interaction.customId) {
            case 'music_previous': {
                const prev = queue.previous();
                if (prev) {
                    await this._startTrack(guildId, player, prev, queue);
                }
                break;
            }
            case 'music_pause': {
                const paused = player.paused;
                await player.setPaused(!paused);
                queue.paused = !paused;
                await this._updatePlayerEmbed(queue);
                break;
            }
            case 'music_skip': {
                await this._playNext(guildId, player);
                break;
            }
            case 'music_stop': {
                await this.stop(guildId);
                await this._updatePlayerEmbed(queue, true);
                break;
            }
            case 'music_loop': {
                const modes = ['off', 'track', 'queue'];
                const idx = modes.indexOf(queue.loopMode);
                queue.loopMode = modes[(idx + 1) % modes.length];
                queue.saveSettings();
                await this._updatePlayerEmbed(queue);
                break;
            }
            case 'music_shuffle': {
                queue.shuffle();
                await this._updatePlayerEmbed(queue);
                break;
            }
            case 'music_autoplay': {
                queue.autoplay = !queue.autoplay;
                queue.saveSettings();
                await this._updatePlayerEmbed(queue);
                break;
            }
            case 'music_voldown': {
                const newVol = Math.max(0, queue.volume - 10);
                await this.setVolume(guildId, newVol);
                await this._updatePlayerEmbed(queue);
                break;
            }
            case 'music_volup': {
                const newVol = Math.min(100, queue.volume + 10);
                await this.setVolume(guildId, newVol);
                await this._updatePlayerEmbed(queue);
                break;
            }
            case 'music_queue': {
                const { createQueueEmbed } = await import('../ui/playerEmbed.js');
                const queueEmbed = createQueueEmbed(queue);
                await interaction.followUp({ embeds: [queueEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
                break;
            }
        }
    }

    /**
     * Skip current track
     */
    async skip(guildId) {
        const player = this.shoukaku.players.get(guildId);
        if (player) {
            await this._playNext(guildId, player);
        }
    }

    /**
     * Pause/Resume
     */
    async togglePause(guildId) {
        const player = this.shoukaku.players.get(guildId);
        if (player) {
            const newState = !player.paused;
            await player.setPaused(newState);
            return newState;
        }
        return false;
    }

    /**
     * Set volume
     */
    async setVolume(guildId, volume) {
        const player = this.shoukaku.players.get(guildId);
        const queue = this.getQueue(guildId);
        queue.volume = volume;
        queue.saveSettings();
        if (player) {
            await player.setGlobalVolume(volume);
        }
    }

    /**
     * Stop playback and clear queue
     */
    async stop(guildId) {
        const queue = this.queues.get(guildId);
        if (queue) {
            this._stopUpdateInterval(queue);
            queue.clear();
            queue.currentTrack = null;
        }
        clearAutoplayBuffer(guildId);
        const player = this.shoukaku.players.get(guildId);
        if (player) {
            await player.stopTrack();
        }
    }

    /**
     * Destroy player and leave voice
     */
    async destroy(guildId) {
        clearAutoplayBuffer(guildId);
        const queue = this.queues.get(guildId);
        if (queue) {
            this._stopUpdateInterval(queue);

            // Send idle embed before destroying
            if (queue.textChannel) {
                try {
                    const embed = createPlayerEmbed(queue, true);
                    const row1 = createControlButtons(queue);
                    const row2 = createExtraButtons(queue);
                    if (queue.playerMessageId) {
                        const msg = await queue.textChannel.messages.fetch(queue.playerMessageId).catch(() => null);
                        if (msg) await msg.edit({ embeds: [embed], components: [row1, row2] }).catch(() => {});
                    }
                } catch {}
            }

            queue.destroy();
            this.queues.delete(guildId);
        }

        await this.shoukaku.leaveVoiceChannel(guildId);
    }
}
