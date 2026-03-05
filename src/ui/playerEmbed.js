import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { formatDuration, createProgressBar, truncate } from '../utils/helpers.js';

// Color scheme — gradient-inspired palette
const COLORS = {
    playing: 0x1DB954,   // Spotify green
    paused: 0xFAA61A,    // Amber
    idle: 0x2F3136,      // Dark embed background
    error: 0xED4245,     // Red
    autoplay: 0x7289DA,  // Discord blurple (autoplay active)
};

// Source icons
const SOURCE_ICONS = {
    youtube: '<:yt:1234> YouTube',
    spotify: '<:sp:1234> Spotify',
    soundcloud: '<:sc:1234> SoundCloud',
    applemusic: 'Apple Music',
    deezer: 'Deezer',
    bandcamp: 'Bandcamp',
    'yt-dlp': 'Direct',
};

function getSourceLabel(sourceName) {
    const key = (sourceName || '').toLowerCase();
    return SOURCE_ICONS[key] || sourceName || 'Unknown';
}

/**
 * Build a volume bar visual
 */
function volumeBar(vol) {
    const blocks = Math.round(vol / 10);
    const filled = '█'.repeat(blocks);
    const empty = '░'.repeat(10 - blocks);
    return `${filled}${empty}`;
}

/**
 * Create the now-playing embed — premium Spotify-inspired design
 */
export function createPlayerEmbed(queue, idle = false) {
    const embed = new EmbedBuilder();

    if (idle || !queue.currentTrack) {
        embed.setColor(COLORS.idle);
        embed.setAuthor({ name: '🎧 HAWK Music Player' });
        embed.setDescription([
            '',
            '```',
            '   No track playing',
            '```',
            '',
            '> 🎵 **Drop a song name or URL** to start playing',
            '> 📝 Or use `/play <song>` anywhere',
            '',
            '```',
            '  Supported: YouTube • Spotify • SoundCloud • Apple Music',
            '```',
        ].join('\n'));
        embed.setFooter({ text: '🔇 Idle • Waiting for requests' });
        embed.setTimestamp();
        return embed;
    }

    const track = queue.currentTrack;
    const info = track.info;
    const position = queue.currentPosition || 0;
    const duration = info.length || 0;
    const posStr = formatDuration(position);
    const durStr = info.isStream ? '🔴 LIVE' : formatDuration(duration);
    const isPaused = queue.paused || false;
    const isAutoplay = track.requestedBy === '🤖 AutoPlay';

    // Color based on state
    const color = isPaused ? COLORS.paused : isAutoplay ? COLORS.autoplay : COLORS.playing;
    embed.setColor(color);

    // Header with status
    const statusIcon = isPaused ? '⏸️' : '▶️';
    const statusText = isPaused ? 'PAUSED' : 'NOW PLAYING';
    embed.setAuthor({ name: `${statusIcon} ${statusText}` });

    // Rich title with link
    const titleLink = info.uri ? `[${truncate(info.title, 60)}](${info.uri})` : truncate(info.title, 60);

    // Progress bar — wider and more visual
    const progress = createProgressBar(position, duration, 20);

    // Mode indicators
    const badges = [];
    if (queue.loopMode === 'track') badges.push('🔂 Track Loop');
    if (queue.loopMode === 'queue') badges.push('🔁 Queue Loop');
    if (queue.autoplay) badges.push('🤖 Autoplay');
    if (queue.twentyFourSeven) badges.push('🌙 24/7');
    const modeStr = badges.length > 0 ? badges.join('  •  ') : '▶️ Normal Mode';

    // Up next preview
    let upNextStr = '';
    if (queue.tracks.length > 0) {
        const next = queue.tracks[0];
        upNextStr = `\n> **Up Next:** ${truncate(next.info.title, 35)} — *${next.info.author}*`;
        if (queue.tracks.length > 1) {
            upNextStr += `\n> *...and ${queue.tracks.length - 1} more in queue*`;
        }
    }

    embed.setDescription([
        `### ${titleLink}`,
        `> 🎤 **${info.author}**`,
        '',
        `\`${posStr}\` ${progress} \`${durStr}\``,
        '',
        `${modeStr}`,
        upNextStr,
    ].join('\n'));

    // Artwork — use image (large) instead of thumbnail for better visual
    if (info.artworkUrl) {
        embed.setThumbnail(info.artworkUrl);
    }

    // Info fields — compact row
    const totalQueueDuration = queue.tracks.reduce((acc, t) => acc + (t.info.length || 0), 0);
    const queueDurStr = totalQueueDuration > 0 ? ` (${formatDuration(totalQueueDuration)})` : '';
    
    embed.addFields(
        { name: '📋 Queue', value: `${queue.size} track${queue.size !== 1 ? 's' : ''}${queueDurStr}`, inline: true },
        { name: '🔊 Volume', value: `\`${volumeBar(queue.volume)}\` ${queue.volume}%`, inline: true },
        { name: '📡 Source', value: getSourceLabel(info.sourceName), inline: true },
    );

    // Footer with requester info
    const footerParts = [];
    if (track.requestedBy) footerParts.push(`Requested by ${track.requestedBy}`);
    footerParts.push(`Loop: ${queue.loopMode}`);
    embed.setFooter({ text: footerParts.join(' • ') });
    embed.setTimestamp();

    return embed;
}

/**
 * Create control buttons — Row 1: Transport controls
 */
export function createControlButtons(queue) {
    const isPaused = queue.paused || false;
    const isIdle = !queue.currentTrack;

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('music_previous')
            .setEmoji('⏮')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isIdle),

        new ButtonBuilder()
            .setCustomId('music_pause')
            .setEmoji(isPaused ? '▶️' : '⏸')
            .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
            .setDisabled(isIdle),

        new ButtonBuilder()
            .setCustomId('music_skip')
            .setEmoji('⏭')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isIdle),

        new ButtonBuilder()
            .setCustomId('music_stop')
            .setEmoji('⏹')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(isIdle),

        new ButtonBuilder()
            .setCustomId('music_shuffle')
            .setEmoji('🔀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isIdle || queue.size < 2),
    );

    return row1;
}

/**
 * Create extra controls — Row 2: Loop, Autoplay, Volume, Queue view
 */
export function createExtraButtons(queue) {
    const isIdle = !queue.currentTrack;

    const loopStyle = queue.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary;
    const loopEmoji = queue.loopMode === 'track' ? '🔂' : '🔁';

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('music_loop')
            .setEmoji(loopEmoji)
            .setStyle(loopStyle)
            .setDisabled(isIdle),

        new ButtonBuilder()
            .setCustomId('music_autoplay')
            .setEmoji('🤖')
            .setStyle(queue.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(isIdle),

        new ButtonBuilder()
            .setCustomId('music_voldown')
            .setEmoji('🔉')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isIdle || queue.volume <= 0),

        new ButtonBuilder()
            .setCustomId('music_volup')
            .setEmoji('🔊')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isIdle || queue.volume >= 100),

        new ButtonBuilder()
            .setCustomId('music_queue')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isIdle && queue.size === 0),
    );

    return row2;
}

/**
 * Create a queue display embed — enhanced design
 */
export function createQueueEmbed(queue, page = 0) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.playing)
        .setAuthor({ name: '📋 Music Queue' });

    if (!queue.currentTrack && queue.isEmpty) {
        embed.setDescription([
            '```',
            '   Queue is empty',
            '```',
            '',
            '> Use `/play <song>` or send a song name in the music channel!',
        ].join('\n'));
        return embed;
    }

    const lines = [];

    if (queue.currentTrack) {
        const ct = queue.currentTrack.info;
        const pos = formatDuration(queue.currentPosition || 0);
        const dur = ct.isStream ? 'LIVE' : formatDuration(ct.length);
        lines.push(`**🎵 Now Playing:**`);
        lines.push(`> [${truncate(ct.title, 50)}](${ct.uri})`);
        lines.push(`> 🎤 ${ct.author} — \`${pos} / ${dur}\``);
        lines.push('');
    }

    const pageSize = 10;
    const start = page * pageSize;
    const pageItems = queue.tracks.slice(start, start + pageSize);

    if (pageItems.length > 0) {
        lines.push('**⏭ Up Next:**');
        pageItems.forEach((track, i) => {
            const num = start + i + 1;
            const dur = formatDuration(track.info.length);
            lines.push(`\`${String(num).padStart(2, ' ')}.\` [${truncate(track.info.title, 38)}](${track.info.uri}) — \`${dur}\``);
            lines.push(`      ↳ *${track.info.author}* • ${track.requestedBy}`);
        });
    }

    const totalPages = Math.ceil(queue.tracks.length / pageSize) || 1;
    const totalDuration = queue.tracks.reduce((acc, t) => acc + (t.info.length || 0), 0);
    const currentDuration = queue.currentTrack?.info?.length || 0;

    embed.setDescription(lines.join('\n') || 'No tracks in queue.');
    embed.setFooter({
        text: `Page ${page + 1}/${totalPages} • ${queue.size} tracks • Total: ${formatDuration(totalDuration + currentDuration)} • Loop: ${queue.loopMode} • Autoplay: ${queue.autoplay ? 'On' : 'Off'}`,
    });

    return embed;
}
