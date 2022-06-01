import crypto from 'node:crypto';
import fs from 'node:fs';
import {Telegraf} from 'telegraf';
import {ApiClient} from '@twurple/api';
import {RefreshingAuthProvider} from '@twurple/auth';
import { Low, JSONFile } from 'lowdb'
import lodash from 'lodash';

class LowWithLodash<T> extends Low<T> {
  chain: lodash.ExpChain<this['data']> = lodash.chain(this).get('data')
}

type ConfigChannelEntry = {
  groupId: number,
  channelId: number,
  bot: string,
};
type Config = {
  twitchClientId: string,
  twitchClientToken: string,
  channels: Record<string, ConfigChannelEntry>,
  bots: Record<string, string>,
};

type ChannelState = {
  lastStreamId: string | null,
  lastStreamTitle: string | null,
  lastMessageId: number | null;
  lastGroupMessageId: number | null,
};
type StatusDb = Record<string, ChannelState>;

const config = JSON.parse(fs.readFileSync('./config.json').toString('utf-8')) as Config;

const twitchBotTokens = JSON.parse(fs.readFileSync('./twitch.tokens.json', 'utf-8').toString());
const authProvider = new RefreshingAuthProvider({
  clientId: config.twitchClientId,
  clientSecret: config.twitchClientToken,
  onRefresh: async newTokenData => {
    return fs.promises.writeFile('./twitch.tokens.json', JSON.stringify(newTokenData, null, 2), 'utf-8');
  }
}, twitchBotTokens);

const bots = Object.fromEntries(Object.entries(config.bots).map(([key, token]) => [key, new Telegraf(token)]));
function getBot(name: string) {
  const bot = bots[name];
  if (!bot) {
    throw new Error(`Unknown bot ${name}`);
  }
  return bot;
}

const apiClient = new ApiClient({authProvider});

const statusDb = new LowWithLodash(new JSONFile<StatusDb>('./state.json'));
await statusDb.read();
statusDb.data ||= {};
for (const channel of Object.keys(config.channels)) {
  const state = statusDb.chain.get(channel).value();
  statusDb.data[channel] = {
    lastStreamId: null,
    lastStreamTitle: null,
    lastMessageId: null,
    lastGroupMessageId: null,
    ...(state as any),
  };
}
await statusDb.write();

async function update(channelName: string, channelConfig: ConfigChannelEntry) {
  const bot = getBot(channelConfig.bot);

  console.log('Checking user ' + channelName + '!');
  const state = statusDb.chain.get(channelName).value();

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
    if (state.lastGroupMessageId) {
      bot.telegram.getChat(channelConfig.groupId).then(async chat => {
        const pinnedMessage = chat.pinned_message;

        if (!pinnedMessage || pinnedMessage.message_id !== state.lastGroupMessageId) {
          state.lastGroupMessageId = null;
          await statusDb.write();
          return;
        }

        console.log('Un-pinning notification!');
        await bot.telegram.unpinChatMessage(channelConfig.groupId);
        state.lastGroupMessageId = null;
        await statusDb.write();
      });
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
  const message = `${title} | IN ONDA | ${streamLinkHtml}`;

  if (state.lastStreamId === stream.id) {
    console.log('Updating alert title!');
    if (!state.lastMessageId) {
      console.error('Missing last message id in status! Skip...'); // Should never happen
      return;
    }
    // Title changed! Edit message!
    await bot.telegram.editMessageText(channelConfig.channelId || channelConfig.groupId, state.lastMessageId, undefined, message, {
      parse_mode: 'HTML'
    });
    await statusDb.write();
    return;
  }
  state.lastStreamId = stream.id;

  // New stream!
  console.log('New stream detected! Notify!');
  // Send notification and pin message
  const sendResult = await bot.telegram.sendMessage(channelConfig.channelId || channelConfig.groupId, message, {
    parse_mode: 'HTML'
  });
  state.lastMessageId = sendResult.message_id;

  if (channelConfig.channelId) {
    const forwardResult = await bot.telegram.forwardMessage(channelConfig.groupId, channelConfig.channelId, state.lastMessageId);
    state.lastGroupMessageId = forwardResult.message_id;
  } else {
    state.lastGroupMessageId = state.lastMessageId;
  }

  await bot.telegram.pinChatMessage(channelConfig.groupId, state.lastGroupMessageId);

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
  await bot.launch();
}

async function updateAll() {
  for (const [channel, channelConfig] of Object.entries(config.channels)) {
    await update(channel, channelConfig);
  }
}

// First update
await updateAll();
// Schedule next updates
setInterval(updateAll, 30 * 1000);
