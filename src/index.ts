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
};
type Config = {
  twitchClientId: string,
  twitchClientToken: string,
  telegramBotToken: string,
  channels: Record<string, ConfigChannelEntry>,
};

type ChannelState = {
  lastStreamId: string | null,
  lastStreamTitle: string | null,
  lastMessageId: number | null;
  lastGroupMessageId: number | null,
};
type StatusDb = Record<string, ChannelState>;

const config = JSON.parse(fs.readFileSync('./config.json').toString('utf-8')) as Config;

const botTokens = JSON.parse(fs.readFileSync('./twitch.tokens.json', 'utf-8').toString());
const authProvider = new RefreshingAuthProvider({
  clientId: config.twitchClientId,
  clientSecret: config.twitchClientToken,
  onRefresh: async newTokenData => {
    return fs.promises.writeFile('./twitch.tokens.json', JSON.stringify(newTokenData, null, 2), 'utf-8');
  }
}, botTokens);

const bot = new Telegraf(config.telegramBotToken);
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

  const streamLinkHtml = `<a href='https://twitch.tv/${stream.userName}?rid=${crypto.randomBytes(5).toString('hex')}'>twitch.tv/cerbero_podcast</a>`;
  const message = `${title} | IN ONDA | ${streamLinkHtml}`;

  if (state.lastStreamId === stream.id) {
    console.log('Updating alert title!');
    if (!state.lastMessageId) {
      console.error('Missing last message id in status! Skip...'); // Should never happen
      return;
    }
    // Title changed! Edit message!
    await bot.telegram.editMessageText(channelConfig.channelId, state.lastMessageId, undefined, message, {
      parse_mode: 'HTML'
    });
    await statusDb.write();
    return;
  }
  state.lastStreamId = stream.id;

  // New stream!
  console.log('New stream detected! Notify!');
  // Send notification and pin message
  const result = await bot.telegram.sendMessage(channelConfig.channelId, message, {
    parse_mode: 'HTML'
  });
  state.lastMessageId = result.message_id;
  /*
  if(pinNotification) {
      bot.telegram.pinChatMessage(telegramGroupId, messageId);
      lastGroupMessageId = messageId;
  }
  */
  await statusDb.write();
}

/*
bot.on('message', (ctx) => {
	for (const channel of config.channels) {
		for (const target of targets) {
			if (target.mode !== 'channel' || !target.linkedGroup) {
				continue;
			}
			if (ctx.chat.id !== target.linkedGroup) {
				continue;
			}
			if (ctx.message.forward_from_chat?.id !== target.id) {
				continue;
			}
			console.log(`Detected a message from a target channel inside the linked group! (Twitch: '${channel.name}', Channel: '${target.id}', Group: '${target.linkedGroup}')`);
			target.lastGroupMessageId = ctx.message.message_id;
		}
		return;
	}
});
*/

bot.on('message', (ctx) => {
  for (const [channel, channelConfig] of Object.entries(config.channels)) {
    if (ctx.chat.id !== channelConfig.groupId) {
      return;
    }
    // @ts-ignore Undocumented field
    const forwardedFrom = ctx.message.forward_from_chat?.id;
    if (forwardedFrom !== channelConfig.channelId) {
      return;
    }
    console.log(`Detected message in group for channel ${channel}!`);
    const state = statusDb.chain.get(channel).value();
    state.lastGroupMessageId = ctx.message.message_id;

  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

await bot.launch();

async function updateAll() {
  for (const [channel, channelConfig] of Object.entries(config.channels)) {
    await update(channel, channelConfig);
  }
}

// First update
await updateAll();
// Schedule next updates
setInterval(updateAll, 30 * 1000);
