var _ = require('lodash');
var irc = require('irc');
var logger = require('winston');
var Slack = require('slack-client');
var errors = require('./errors');
var validateChannelMapping = require('./validators').validateChannelMapping;

var REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
function Bot(options) {
  REQUIRED_FIELDS.forEach(function(field) {
    if (!options[field]) {
      throw new errors.ConfigurationError('Missing configuration field ' + field);
    }
  });
  validateChannelMapping(options.channelMapping);

  this.slack = new Slack(options.token);
  this._admin = options.admin;

  this.server = options.server;
  this.nickname = options.nickname;
  this.ircOptions = options.ircOptions;

  this.forward = options.forward;
  this.preserve = options.preserve || [];

  this.channels = _.values(options.channelMapping);

  this.channelMapping = {};

  // Remove channel passwords from the mapping
  _.forOwn(options.channelMapping, function(ircChan, slackChan) {
    this.channelMapping[slackChan] = ircChan.split(' ')[0];
  }, this);

  this.invertedMapping = _.invert(this.channelMapping);

  this.autoSendCommands = options.autoSendCommands || [];
}

Bot.prototype.connect = function() {
  logger.debug('Connecting to IRC and Slack');
  this.slack.login();

  var ircOptions = _.assign({
    userName: this.nickname,
    realName: this.nickname,
    channels: this.channels,
    floodProtection: true,
    floodProtectionDelay: 500
  }, this.ircOptions);

  this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
  this.attachListeners();
};

var dupes = {};

Bot.prototype.attachListeners = function() {
  this.slack.on('open', function() {
    logger.debug('Connected to Slack');
  });

  this.ircClient.on('registered', function(message) {
    logger.debug('Registered event: ', message);
    this.autoSendCommands.forEach(function(element) {
      this.ircClient.send.apply(this.ircClient, element);
    }, this);
  }.bind(this));

  this.ircClient.on('error', function(error) {
    logger.error('Received error event from IRC', error);
  });

  this.slack.on('error', function(error) {
    logger.error('Received error event from Slack', error);
  });

  this.slack.on('message', function(message) {
    // Ignore bot messages and people leaving/joining
    if (message.type === 'message' && !message.subtype) {
      var username = this.slack.getUserByID(message.user).name;

      if (this.nickname == username) {
        this.sendToIRC(message);
        return;
      }

      if (!this.forward || this.preserve.indexOf(username) != -1) {
        return;
      }

      message.deleted = true;
      message._onDeleteMessage = function () {
        this._client.logger.debug(arguments);
      }.bind(message);
      var bkp = message._client.token;
      message._client.token = this._admin;
      message.deleteMessage();
      message._client.token = bkp;

      if (dupes[message.ts]) {
        return;
      }
      dupes[message.ts] = true;

      this.slack.openDM(message.user, function (res) {
        if (!res || !res.channel) {
          return;
        }

        var slackChannel = this.slack.getChannelGroupOrDMByName(this.slack.getUserByID(message.user).name);

        if (!slackChannel) {
          logger.info('Tried to send a message to a channel the bot isn\'t in: ',
            res.channel.id);
          return;
        }

        slackChannel.postMessage({
          text: "You are not allowed to post to the IRC channel from Slack. Contact @tcreate if you would like this enabled for your account.",
          parse: 'full',
        })
      }.bind(this))
    }
  }.bind(this));

  this.ircClient.on('message', this.sendToSlack.bind(this));

  this.ircClient.on('invite', function(channel, from) {
    logger.debug('Received invite:', channel, from);
    if (!this.invertedMapping[channel]) {
      logger.debug('Channel not found in config, not joining:', channel);
    } else {
      this.ircClient.join(channel);
      logger.debug('Joining channel:', channel);
    }
  }.bind(this));
};

Bot.prototype.parseText = function(text) {
  return text
    .replace(/\n|\r\n|\r/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<!channel>/g, '@channel')
    .replace(/<!group>/g, '@group')
    .replace(/<!everyone>/g, '@everyone')
    .replace(/<#(C\w+)\|?(\w+)?>/g, function(match, channelId, readable) {
      return readable || '#' + this.slack.getChannelByID(channelId).name;
    }.bind(this))
    .replace(/<@(U\w+)\|?(\w+)?>/g, function(match, userId, readable) {
      return readable || '@' + this.slack.getUserByID(userId).name;
    }.bind(this))
    .replace(/<(?!!)(\S+)>/g, function(match, link) {
      return link;
    })
    .replace(/<!(\w+)\|?(\w+)?>/g, function(match, command, label) {
      if (label) {
        return '<' + label + '>';
      }
      return '<' + command + '>';
    });
};

Bot.prototype.sendToIRC = function(message) {
  var channel = this.slack.getChannelGroupOrDMByID(message.channel);
  if (!channel) {
    logger.info('Received message from a channel the bot isn\'t in:',
      message.channel);
    return;
  }

  var channelName = channel.is_channel ? '#' + channel.name : channel.name;
  var ircChannel = this.channelMapping[channelName];

  logger.debug('chan', channelName, this.channelMapping[channelName]);
  if (ircChannel && this.ircClient.maxLineLength) {
    var user = this.slack.getUserByID(message.user);
    var text = this.parseText(message.getBody());
    logger.debug('Sending message to IRC', channelName, text);
    this.ircClient.say(ircChannel, text);
  }
};

Bot.prototype.sendToSlack = function(author, channel, text) {
  if (!this.forward) {
    return;
  }

  if (this.preserve.some(function (name) {
    return name == author.slice(0, name.length);
  })) {
    // Ignore suffixed names double-posts
    return;
  }

  var slackChannelName = this.invertedMapping[channel];
  console.log(slackChannelName);
  if (slackChannelName) {
    var slackChannel = this.slack.getChannelGroupOrDMByName(slackChannelName);

    if (!slackChannel) {
      logger.info('Tried to send a message to a channel the bot isn\'t in: ',
        slackChannelName);
      return;
    }

    var crypto = require('crypto');
    var message = {
      text: text,
      username: author,
      parse: 'full',
      icon_url: 'http://www.gravatar.com/avatar/' + crypto.createHash('md5').update(author).digest('hex') + '?s=48&r=any&default=identicon&forcedefault=1',
      // icon_url: 'http://api.adorable.io/avatars/48/' + author + '.png'
    };
    logger.debug('Sending message to Slack', message, channel, '->', slackChannelName);
    slackChannel.postMessage(message);
  }
};

module.exports = Bot;
