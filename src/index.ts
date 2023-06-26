import crypto from 'node:crypto';
import fs from 'node:fs';
import {Telegraf} from 'telegraf';
import {ApiClient} from '@twurple/api';
import {RefreshingAuthProvider} from '@twurple/auth';
import {JSONFile} from 'lowdb/node'
import {escape} from 'html-escaper';
import {fulfillWithTimeLimit} from "./utils.js";
import {Low} from "lowdb";

type ConfigChannelEntry = {
    groupIds: number[],
    channelIds: number[],
    bot: string,
};
export type Config = {
    twitchClientId: string,
    twitchClientToken: string,
    channels: Record<string, ConfigChannelEntry>,
    bots: Record<string, string>,
};

type ChannelState = {
    lastStreamId: string | null,
    lastStreamTitle: string | null,
    channels: Record<string, number | null>
    groups: Record<string, number | null>
};
type StatusDb = Record<string, ChannelState>;

const config = JSON.parse(fs.readFileSync('./config.json').toString('utf-8')) as Config;

const twitchBotTokens = JSON.parse(fs.readFileSync('./twitch.tokens.json', 'utf-8').toString());
const authProvider = new RefreshingAuthProvider({
    clientId: config.twitchClientId,
    clientSecret: config.twitchClientToken,
    onRefresh: async (userId, newTokenData) => {
        return fs.promises.writeFile('./twitch.tokens.json', JSON.stringify(newTokenData, null, 2), 'utf-8');
    }
});
await authProvider.addUserForToken(twitchBotTokens, []);

const bots = Object.fromEntries(Object.entries(config.bots).map(([key, token]) => [key, new Telegraf(token)]));

function getBot(name: string) {
    const bot = bots[name];
    if (!bot) {
        throw new Error(`Unknown bot ${name}`);
    }
    return bot;
}

const apiClient = new ApiClient({authProvider});

const statusDb = new Low(new JSONFile<StatusDb>('./state.json'), {});
await statusDb.read();
statusDb.data ||= {};
for (const channel of Object.keys(config.channels)) {
    const state = statusDb.data[channel];
    statusDb.data[channel] = {
        lastStreamId: null,
        lastStreamTitle: null,
        channels: {},
        groups: {},
        ...(state as any),
    };
}
await statusDb.write();

async function update(channelName: string, channelConfig: ConfigChannelEntry) {
    const bot = getBot(channelConfig.bot);

    console.log('Checking user ' + channelName + '!');
    const state = statusDb.data[channelName];

    // Resolve user id by name
    const users = await apiClient.users.getUsersByNames([channelName]);
    if (users.length === 0) {
        console.log('EMPTY RESULT!');
        return;
    }

    const userId = users[0].id;
    console.log('UserId is ' + userId + '!');

    // Get the channel's current stream
    const stream = await apiClient.streams.getStreamByUserId(userId);
    if (!stream) {
        // Handle offline
        console.log('Not online!');

        // Unpin the pinned notification, if present
        for (const [groupId, lastGroupMessageId] of Object.entries(state.groups)) {
            if (!lastGroupMessageId) {
                continue;
            }

            console.log('Un-pinning notification!');
            try {
                await bot.telegram.unpinChatMessage(groupId, lastGroupMessageId);
            } catch (error) {
                console.warn('Unable to unpin message', error);
            }
            state.groups[groupId] = null;
            await statusDb.write();

            /*
            bot.telegram.getChat(groupId).then(async chat => {
              const pinnedMessage = chat.pinned_message;
              if (!pinnedMessage || pinnedMessage.message_id !== lastGroupMessageId) {
                state.groups[groupId] = null;
                await statusDb.write();
                return;
              }
              console.log('Un-pinning notification!');
              try {
                await bot.telegram.unpinChatMessage(groupId, lastGroupMessageId);
              } catch (error) {
                console.warn('Unable to unpin message', error);
              }
              state.groups[groupId] = null;
              await statusDb.write();
            });
            */
        }

        return;
    }

    // Handle online
    const title = stream.title;
    console.log('Online: ' + title);

    // Check if this stream was already notified
    if (state.lastStreamTitle === title) {
        // Same title as previous stream, ignore
        console.log('Already notified! Skip...');
        return;
    }
    state.lastStreamTitle = title;

    const streamLinkHtml = `<a href='https://twitch.tv/${stream.userName}?rid=${crypto.randomBytes(5).toString('hex')}'>twitch.tv/${stream.userName}</a>`;
    const message = `${escape(title)} <b>| IN ONDA |</b> ${streamLinkHtml}`;

    if (state.lastStreamId === stream.id) {
        // Title changed! Edit message!
        console.log('Updating alert title!');
        let changes = false;
        for (const [channelId, lastMessageId] of Object.entries(state.channels)) {
            if (!lastMessageId) {
                console.error('Missing last message id in status! Skip...'); // Should never happen
                continue;
            }
            await bot.telegram.editMessageText(channelId, lastMessageId, undefined, message, {
                parse_mode: 'HTML'
            });
            changes = true;
        }
        for (const [groupId, lastGroupMessageId] of Object.entries(state.groups)) {
            if (!lastGroupMessageId) {
                console.error('Missing last group message id in status! Skip...'); // Should never happen
                continue;
            }
            await bot.telegram.editMessageText(groupId, lastGroupMessageId, undefined, message, {
                parse_mode: 'HTML'
            });
            changes = true;
        }
        if (changes) {
            await statusDb.write();
        }
        return;
    }
    state.lastStreamId = stream.id;

    // New stream!
    console.log('New stream detected! Notify!');

    // Cleanup removed groups and channels
    for (const channelId in state.channels) {
        if (channelConfig.channelIds.includes(parseInt(channelId))) {
            continue;
        }
        delete state.channels[channelId];
    }
    for (const groupId in state.groups) {
        if (channelConfig.channelIds.includes(parseInt(groupId))) {
            continue;
        }
        delete state.channels[groupId];
    }

    // Send notification and pin message
    for (const channelId of channelConfig.channelIds) {
        const sendResult = await bot.telegram.sendMessage(channelId, message, {
            parse_mode: 'HTML'
        });
        state.channels[channelId] = sendResult.message_id;
    }
    for (const groupId of channelConfig.groupIds) {
        /*
        const channelId = channelConfig.channelIds[0];
        if (channelId) {
          const forwardResult = await bot.telegram.forwardMessage(groupId, channelId, state.channels[channelId]!);
          state.groups[groupId] = forwardResult.message_id;
        } else {
          const sendResult = await bot.telegram.sendMessage(groupId, message, {
            parse_mode: 'HTML'
          });
          state.groups[groupId] = sendResult.message_id;
        }
        */
        const sendResult = await bot.telegram.sendMessage(groupId, message, {
            parse_mode: 'HTML'
        });
        state.groups[groupId] = sendResult.message_id;
        await bot.telegram.pinChatMessage(groupId, state.groups[groupId]!);
    }

    await statusDb.write();
}

process.once('SIGINT', () => {
    for (const bot of Object.values(bots)) {
        bot.stop('SIGINT');
    }
});
process.once('SIGTERM', () => {
    for (const bot of Object.values(bots)) {
        bot.stop('SIGTERM');
    }
});

for (const bot of Object.values(bots)) {
    console.log(`Starting bot ${bot.telegram.token}`);
    bot.launch()
        .then();
}

async function updateAll() {
    for (const [channel, channelConfig] of Object.entries(config.channels)) {
        await fulfillWithTimeLimit(15 * 1000, update(channel, channelConfig));
    }
    // Cleanup
    let changes = false;
    for (const channel in statusDb.data) {
        if (config.channels[channel]) {
            continue;
        }
        changes = true;
        delete statusDb.data[channel];
        console.log(`Removing ${channel} from db`);
    }
    if (changes) {
        await statusDb.write();
    }
}

let running = true;
let stopSleep: (() => void) | undefined;
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received.');
    running = false;
    if (stopSleep) {
        stopSleep();
    }
});

console.log('Starting...');

while (running) {
    try {
        await updateAll();
    } catch (e) {
        console.error(e);
    }
    await new Promise(resolve => {
        setTimeout(resolve, 30 * 10000);
        stopSleep = resolve as any;
    });
    stopSleep = undefined;
}

console.log('Graceful shutdown done!');
process.exit(0);
